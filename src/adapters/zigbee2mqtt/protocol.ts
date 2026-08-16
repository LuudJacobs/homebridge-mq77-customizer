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
