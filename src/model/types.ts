/**
 * The normalised model every adapter produces.
 *
 * The HomeKit mapper and the rules engine are written against this and nothing
 * else, so a new source format only ever means a new adapter.
 */

export type PropertyType = 'binary' | 'numeric' | 'enum' | 'text';

/**
 * How prominent a property is. Adapters that have no opinion report `primary`.
 * The web interface uses this to fold away the noise by default.
 */
export type PropertyCategory = 'primary' | 'config' | 'diagnostic';

export interface PropertyAccess {
  /** The value arrives in state messages. */
  readable: boolean;
  /** The value can be written by publishing to `setTopic`. */
  writable: boolean;
}

export interface NormalisedProperty {
  /** Unique within the device. Usually the wire property name, endpoint suffix included. */
  key: string;
  /** Human readable, for the web interface. */
  label: string;
  /**
   * Source independent meaning, used by the HomeKit mapper to pick a service.
   * `temperature`, `humidity`, `battery`, `state`, `brightness` and so on.
   * Undefined when the adapter cannot say.
   */
  semantic?: string;
  type: PropertyType;
  access: PropertyAccess;
  category: PropertyCategory;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Allowed values for `enum`. */
  values?: (string | number)[];
  /** Wire representation for `binary`. */
  onValue?: string | number | boolean;
  offValue?: string | number | boolean;
  toggleValue?: string | number | boolean;
  /**
   * Endpoint this property belongs to, for devices that expose several
   * independent channels (`l1`, `l2`). Undefined for single endpoint devices.
   */
  endpoint?: string;
  /** Set when the property sits inside a composite, naming the group. */
  group?: string;
  /** Topic carrying this property's value. */
  stateTopic: string;
  /** Topic to publish changes to. Absent means read only regardless of `access`. */
  setTopic?: string;
  /**
   * Path to the value inside the state payload. An empty array means the
   * payload itself is the value. Nested for properties inside a composite.
   */
  extract: string[];
  /** Path to write the value at inside the set payload. Defaults to `extract`. */
  encode?: string[];
}

export interface NormalisedDevice {
  /** The source this device came from. */
  sourceId: string;
  /** Stable within the source. IEEE address for Zigbee2MQTT, topic for others. */
  deviceId: string;
  /** Display name. */
  name: string;
  manufacturer?: string;
  model?: string;
  description?: string;
  properties: NormalisedProperty[];
}

/** Globally unique key for a device across all sources. */
export function deviceKey(device: Pick<NormalisedDevice, 'sourceId' | 'deviceId'>): string {
  return `${device.sourceId}:${device.deviceId}`;
}

/** Last known value of every property of a device, keyed by property key. */
export type DeviceState = Record<string, unknown>;

/** Emitted whenever an adapter sees new values. */
export interface StateUpdate {
  sourceId: string;
  deviceId: string;
  /** Only the properties present in this message. */
  changes: DeviceState;
  /** Epoch milliseconds the update was received. */
  at: number;
  /**
   * True when the value came from a retained message replayed on connect
   * rather than a live change. The rules engine must not fire on these.
   */
  retained: boolean;
}
