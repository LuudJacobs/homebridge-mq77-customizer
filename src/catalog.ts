import { EventEmitter } from 'node:events';

import { getAdapterFactory } from './adapters/index.js';
import type { NetworkMap, SourceAdapter, SourceConfig } from './adapters/types.js';
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
  /** What each device last said about when it was heard, where it says so. */
  private readonly reportedLastSeen = new Map<string, string | number>();

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
    this.reportedLastSeen.clear();
  }

  /**
   * Whether a source has told us what it has.
   *
   * Until it has, an empty catalog means "not yet" rather than "nothing", and
   * the difference matters: acting on the second would remove accessories that
   * are about to come back.
   */
  /**
   * The network behind the first source that has one to describe.
   *
   * Only Zigbee2MQTT can answer this. A flat JSON publisher has no mesh, so
   * the absence of an answer is the normal case rather than a failure.
   */
  async getNetworkMap(): Promise<NetworkMap | undefined> {
    for (const adapter of this.adapters.values()) {
      if (adapter.getNetworkMap) {
        return adapter.getNetworkMap();
      }
    }
    return undefined;
  }

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

  /**
   * When the device itself last said it was heard.
   *
   * The only account of it there is: when a message arrived says when the
   * broker sent it, which for a retained one is the moment we connected
   * rather than the moment the device spoke. Zigbee2MQTT publishes this when
   * `advanced.last_seen` is turned on, and a device that publishes none is
   * a device nothing can be said about.
   */
  getReportedLastSeen(sourceId: string, deviceId: string): string | number | undefined {
    return this.reportedLastSeen.get(`${sourceId}:${deviceId}`);
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
    if (update.reportedLastSeen !== undefined) {
      this.reportedLastSeen.set(deviceKey(update), update.reportedLastSeen);
    }
    this.emit('state', update);
  }
}
