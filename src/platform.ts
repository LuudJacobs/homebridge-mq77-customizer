import type {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';

import { Catalog } from './catalog.js';
import { resolveConfig, type PluginConfig } from './config.js';
import { AccessoryManager } from './homekit/manager.js';
import { MqttConnection } from './mqtt/client.js';
import { RulesEngine } from './rules/engine.js';
import { LEGACY_STORAGE_DIR, STORAGE_DIR } from './settings.js';
import { Store, storeFile } from './store.js';
import { WebServer } from './web/server.js';

export class Mq77CustomizerPlatform implements DynamicPlatformPlugin {
  private readonly settings: PluginConfig;
  private readonly mqtt: MqttConnection;
  private readonly catalog: Catalog;
  private readonly store: Store;
  private readonly accessories: AccessoryManager;
  private readonly rules: RulesEngine;
  private web?: WebServer;

  constructor(
    private readonly log: Logging,
    config: PlatformConfig,
    private readonly api: API,
  ) {
    this.settings = resolveConfig(config as Record<string, unknown>, log);
    this.mqtt = new MqttConnection(this.settings.broker, log);
    this.catalog = new Catalog(this.mqtt, log);
    this.store = new Store(
      storeFile(api.user.storagePath(), STORAGE_DIR),
      log,
      storeFile(api.user.storagePath(), LEGACY_STORAGE_DIR),
    );
    this.accessories = new AccessoryManager(api, log, this.catalog, this.store, this.mqtt);
    this.rules = new RulesEngine(this.catalog, this.store, this.mqtt, log);

    this.api.on('didFinishLaunching', () => {
      void this.start();
    });

    this.api.on('shutdown', () => {
      void this.stop();
    });
  }

  /** Homebridge replays cached accessories here before `didFinishLaunching`. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.restore(accessory);
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

    // Reconcile whenever the catalog changes, so a device joining or leaving
    // adds or removes its accessories without a restart.
    this.catalog.on('devices', () => this.accessories.sync());
    this.catalog.on('state', (update) => {
      this.accessories.handleState(update);
      this.rules.handleState(update);
    });

    try {
      await this.catalog.start(this.settings.sources);
    } catch (error) {
      this.log.error(`Could not start sources: ${describe(error)}`);
      return;
    }

    // Runs once with whatever the catalog already holds, which also clears
    // cached accessories belonging to devices or selections that are gone.
    this.accessories.sync();

    this.web = new WebServer({
      config: this.settings.web,
      catalog: this.catalog,
      store: this.store,
      rules: this.rules,
      log: this.log,
      onExposureChanged: () => this.accessories.sync(),
    });

    try {
      await this.web.start();
    } catch (error) {
      this.log.error(`Could not start the web interface: ${describe(error)}`);
      this.web = undefined;
    }

    const ruleCount = this.store.data.rules.filter((rule) => rule.enabled).length;
    this.log.info(
      `Started with ${this.settings.sources.length} source(s) and ${ruleCount} enabled rule(s)`,
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

    this.rules.stop();
    await withTimeout(this.web?.stop() ?? Promise.resolve(), 2000);
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
