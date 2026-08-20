import { EventEmitter } from 'node:events';

import { getAdapterFactory } from './adapters/index.js';
import type { SourceAdapter, SourceConfig } from './adapters/types.js';
import { prefixed, type Logger } from './logger.js';
import type { MqttConnection } from './mqtt/client.js';
import { deviceKey, type NormalisedDevice, type StateUpdate } from './model/types.js';

export interface CatalogDevice extends NormalisedDevice {
  /** Whether this device's source publishes accessories to HomeKit. */
  rulesOnly: boolean;
  /** Whether a name can be given here, or belongs to the source instead. */
  renameable: boolean;
}

export interface CatalogEvents {
  /** The combined catalog changed. */
  devices: [CatalogDevice[]];
  /** New values arrived, forwarded from an adapter. */
  state: [StateUpdate];
}

/**
 * The combined view over every source.
 *
 * Everything downstream (the web interface, the HomeKit mapper, the rules
 * engine) reads from here rather than from adapters directly.
 */
export class Catalog extends EventEmitter<CatalogEvents> {
  private readonly adapters = new Map<string, SourceAdapter>();
  private readonly sources = new Map<string, SourceConfig>();
  /** Sources that have produced a catalog at least once since starting. */
  private readonly reported = new Set<string>();
  private devices: CatalogDevice[] = [];
  /** Epoch millis a property last carried a value, keyed `sourceId:deviceId` then property key. */
  private readonly lastSeen = new Map<string, Map<string, number>>();

  constructor(
    private readonly mqtt: MqttConnection,
    private readonly log: Logger,
  ) {
    super();
  }

  async start(sources: SourceConfig[]): Promise<void> {
    for (const source of sources) {
      const factory = getAdapterFactory(source.adapter);
      if (!factory) {
        // resolveConfig already rejected unknown adapters, so this only fires
        // if the two ever drift apart.
        this.log.error(`No adapter named "${source.adapter}" for source "${source.id}"`);
        continue;
      }

      const adapter = factory({
        source,
        mqtt: this.mqtt,
        log: prefixed(this.log, source.id),
      });

      adapter.on('devices', () => {
        this.reported.add(source.id);
        this.rebuild();
      });
      adapter.on('state', (update) => this.handleState(update));

      this.adapters.set(source.id, adapter);
      this.sources.set(source.id, source);
      await adapter.start();
    }

    this.rebuild();
  }

  async stop(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.stop();
    }
    this.adapters.clear();
    this.sources.clear();
    this.reported.clear();
    this.devices = [];
    this.lastSeen.clear();
  }

  /**
   * Whether a source has told us what it has.
   *
   * Until it has, an empty catalog means "not yet" rather than "nothing", and
   * the difference matters: acting on the second would remove accessories that
   * are about to come back.
   */
  hasReported(sourceId: string): boolean {
    return this.reported.has(sourceId);
  }

  /** True once every configured source has been heard from. */
  knowsEverything(): boolean {
    return [...this.adapters.keys()].every((sourceId) => this.reported.has(sourceId));
  }

  getDevices(): CatalogDevice[] {
    return this.devices;
  }

  getDevice(sourceId: string, deviceId: string): CatalogDevice | undefined {
    return this.devices.find(
      (device) => device.sourceId === sourceId && device.deviceId === deviceId,
    );
  }

  getState(sourceId: string, deviceId: string): Readonly<Record<string, unknown>> | undefined {
    return this.adapters.get(sourceId)?.getState(deviceId);
  }

  /** Epoch millis the property last carried a value, or undefined if never. */
  getLastSeen(sourceId: string, deviceId: string, propertyKey: string): number | undefined {
    return this.lastSeen.get(`${sourceId}:${deviceId}`)?.get(propertyKey);
  }

  private rebuild(): void {
    const devices: CatalogDevice[] = [];
    for (const [sourceId, adapter] of this.adapters) {
      const rulesOnly = this.sources.get(sourceId)?.rulesOnly === true;
      const renameable = !adapter.providesNames;
      for (const device of adapter.getDevices()) {
        devices.push({ ...device, rulesOnly, renameable });
      }
    }
    this.devices = devices;
    this.emit('devices', devices);
  }

  private handleState(update: StateUpdate): void {
    const key = deviceKey(update);
    let seen = this.lastSeen.get(key);
    if (!seen) {
      seen = new Map();
      this.lastSeen.set(key, seen);
    }
    for (const propertyKey of Object.keys(update.changes)) {
      seen.set(propertyKey, update.at);
    }
    this.emit('state', update);
  }
}
