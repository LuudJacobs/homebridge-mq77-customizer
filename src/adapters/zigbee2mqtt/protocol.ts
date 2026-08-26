/** The parts of the Zigbee2MQTT `bridge/devices` payload we read. */

export interface Z2mExpose {
  type: string;
  name?: string;
  label?: string;
  property?: string;
  /** Bitmask: 1 published in state, 2 settable, 4 gettable. */
  access?: number;
  description?: string;
  category?: 'config' | 'diagnostic';
  endpoint?: string;
  features?: Z2mExpose[];
  unit?: string;
  value_max?: number;
  value_min?: number;
  value_step?: number;
  values?: (string | number)[];
  value_on?: string | number | boolean;
  value_off?: string | number | boolean;
  value_toggle?: string | number | boolean;
}

export interface Z2mDefinition {
  model?: string;
  vendor?: string;
  description?: string;
  exposes?: Z2mExpose[];
}

export interface Z2mDevice {
  ieee_address: string;
  friendly_name: string;
  type: string;
  disabled?: boolean;
  description?: string;
  manufacturer?: string;
  model_id?: string;
  supported?: boolean;
  definition?: Z2mDefinition | null;
}

export const ACCESS_PUBLISHED = 1;
export const ACCESS_SET = 2;

/**
 * Exposes that describe a whole function rather than a single value. They hold
 * their features flat in the payload, unlike `composite`.
 */
export const SPECIFIC_TYPES = new Set(['light', 'switch', 'fan', 'cover', 'lock', 'climate']);

/**
 * The parts of the `bridge/info` config we read.
 *
 * It carries the whole running configuration, of which one setting matters
 * here: whether the broker keeps a device's messages for the next subscriber.
 */
export interface Z2mConfig {
  mqtt?: { force_disable_retain?: boolean };
  /** Defaults every device inherits unless its own block says otherwise. */
  device_options?: { retain?: boolean };
  /** Keyed by IEEE address, holding only what was set for that device. */
  devices?: Record<string, { retain?: boolean } | undefined>;
}
