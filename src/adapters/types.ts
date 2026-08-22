import type { EventEmitter } from 'node:events';

import type { Logger } from '../logger.js';
import type { MqttConnection } from '../mqtt/client.js';
import type { NormalisedDevice, StateUpdate } from '../model/types.js';

export interface SourceConfig {
  id: string;
  adapter: string;
  baseTopic: string;
  rulesOnly?: boolean;
  /** Explicit subscription filter. Defaults to everything under `baseTopic`. */
  topics?: string;
  /** Suffix that turns a state topic into a command topic, usually `set`. */
  setTopicSuffix?: string;
  /**
   * Functions a device has that it may never mention.
   *
   * A flat JSON topic carries no schema, so a key is only known once it has
   * turned up in a payload. A fan that reports nothing but `state` until
   * someone changes its speed is invisible up to that point, and saying so
   * here fills the gap.
   */
  devices?: DeclaredDevice[];
}

export interface DeclaredDevice {
  /** The device topic, relative to `baseTopic`. */
  topic: string;
  properties: string[];
}

export interface AdapterContext {
  source: SourceConfig;
  mqtt: MqttConnection;
  log: Logger;
}

export interface AdapterEvents {
  /** The device catalog changed. Carries the full new catalog, not a delta. */
  devices: [NormalisedDevice[]];
  /** New values arrived for a device. */
  state: [StateUpdate];
}

/**
 * Turns one source's MQTT traffic into the normalised model.
 *
 * Adapters own their subscriptions and are responsible for unsubscribing in
 * `stop()`. They never touch HomeKit.
 */
/** A device as the network sees it, rather than as HomeKit does. */
export interface NetworkNode {
  address: string;
  name: string;
  kind: 'coordinator' | 'router' | 'end device';
  /** Set when the device did not answer the scan. */
  failed?: boolean;
}

export interface NetworkLink {
  from: string;
  to: string;
  /** 0 to 255, as the radio reports it. */
  quality: number;
}

export interface NetworkMap {
  nodes: NetworkNode[];
  links: NetworkLink[];
  /** When the scan finished, since one takes long enough to be worth saying. */
  at: number;
}

export interface SourceAdapter extends EventEmitter<AdapterEvents> {
  readonly sourceId: string;
  /**
   * True when the source is the authority on device names.
   *
   * Zigbee2MQTT is, so renaming a device here as well would leave two names
   * that drift apart. A source that names devices after their topic is not.
   */
  readonly providesNames: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** The catalog as currently known. Empty until discovery has produced anything. */
  getDevices(): NormalisedDevice[];
  /** Last known values for a device, keyed by property key. */
  getState(deviceId: string): Readonly<Record<string, unknown>> | undefined;
  /**
   * Asks the network how it is put together.
   *
   * Only a source that has a network to ask. A scan is slow, minutes on a
   * large mesh, and every device is questioned in turn, so this is only ever
   * called because somebody asked for it.
   */
  getNetworkMap?(): Promise<NetworkMap>;
}

export type AdapterFactory = (context: AdapterContext) => SourceAdapter;
