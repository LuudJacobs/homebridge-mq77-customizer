import type {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';

import { Catalog } from './catalog.js';
import { resolveConfig, type PluginConfig } from './config.js';
import { MqttConnection } from './mqtt/client.js';
import { PLATFORM_NAME, PLUGIN_NAME, STORAGE_DIR } from './settings.js';
import { Store, storeFile } from './store.js';

export class MqttCustomizerPlatform implements DynamicPlatformPlugin {
  private readonly settings: PluginConfig;
  private readonly mqtt: MqttConnection;
  private readonly catalog: Catalog;
  private readonly store: Store;

  /** Accessories restored from Homebridge's cache, keyed by UUID. */
  private readonly cached = new Map<string, PlatformAccessory>();

  constructor(
    private readonly log: Logging,
    config: PlatformConfig,
    private readonly api: API,
  ) {
    this.settings = resolveConfig(config as Record<string, unknown>, log);
    this.mqtt = new MqttConnection(this.settings.broker, log);
    this.catalog = new Catalog(this.mqtt, log);
    this.store = new Store(storeFile(api.user.storagePath(), STORAGE_DIR), log);

    this.api.on('didFinishLaunching', () => {
      void this.start();
    });

    this.api.on('shutdown', () => {
      void this.stop();
    });
  }

  /** Homebridge replays cached accessories here before `didFinishLaunching`. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory);
  }

  private async start(): Promise<void> {
    try {
      await this.store.load();
    } catch (error) {
      // Continuing would overwrite a file the user could still recover, so
      // stop here and let them fix or move it.
      this.log.error(describe(error));
      this.log.error('Refusing to start with unreadable state. Nothing was changed.');
      return;
    }

    if (this.settings.sources.length === 0) {
      this.log.warn('No usable sources configured, nothing to do');
      return;
    }

    this.mqtt.connect();

    try {
      await this.catalog.start(this.settings.sources);
    } catch (error) {
      this.log.error(`Could not start sources: ${describe(error)}`);
      return;
    }

    this.catalog.on('devices', (devices) => {
      this.log.debug(`Catalog now holds ${devices.length} devices across all sources`);
    });

    if (this.cached.size > 0) {
      // v0.1.0 publishes no accessories, so anything cached is stale.
      this.log.info(`Removing ${this.cached.size} cached accessories from a previous version`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
        ...this.cached.values(),
      ]);
      this.cached.clear();
    }

    this.log.info(
      `Started with ${this.settings.sources.length} source(s). ` +
        'The web interface arrives in v0.2.0.',
    );
  }

  /**
   * Homebridge allows five seconds after `shutdown` before it exits, so this
   * has to finish quickly. State is saved first because it is the only thing
   * whose loss would matter, and tearing down a stuck broker connection must
   * not be able to starve it.
   */
  private async stop(): Promise<void> {
    try {
      await this.store.save();
    } catch (error) {
      this.log.error(`Could not save state on shutdown: ${describe(error)}`);
    }

    await this.catalog.stop();
    await withTimeout(this.mqtt.disconnect(), 2000);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resolves either way, so a hung teardown step cannot block the ones after it. */
async function withTimeout(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    work,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  if (timer) {
    clearTimeout(timer);
  }
}
