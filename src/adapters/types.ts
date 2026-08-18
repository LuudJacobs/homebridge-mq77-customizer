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
}

export type AdapterFactory = (context: AdapterContext) => SourceAdapter;
