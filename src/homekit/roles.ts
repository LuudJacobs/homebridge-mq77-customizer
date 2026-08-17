import type { NormalisedProperty } from '../model/types.js';

/**
 * What a property means to HomeKit.
 *
 * This is the property-name to characteristic table. Adding support for a new
 * kind of sensor is a line here, not a change to the mapper, and it applies to
 * every device that uses the same property name regardless of vendor.
 */
export type Role =
  | 'power'
  | 'brightness'
  | 'childLock'
  | 'temperature'
  | 'humidity'
  | 'battery'
  | 'thermostatMode'
  | 'targetTemperature'
  | 'localTemperature'
  | 'action';

/** Which service a role contributes to. */
export type ServiceGroup =
  | 'tile'
  | 'thermostat'
  | 'temperature'
  | 'humidity'
  | 'battery'
  | 'buttons';

export const ROLE_GROUPS: Record<Role, ServiceGroup> = {
  power: 'tile',
  brightness: 'tile',
  childLock: 'tile',
  temperature: 'temperature',
  humidity: 'humidity',
  battery: 'battery',
  thermostatMode: 'thermostat',
  targetTemperature: 'thermostat',
  localTemperature: 'thermostat',
  action: 'buttons',
};

const NUMERIC_ROLES: Record<string, Role> = {
  brightness: 'brightness',
  temperature: 'temperature',
  humidity: 'humidity',
  battery: 'battery',
  local_temperature: 'localTemperature',
  occupied_heating_setpoint: 'targetTemperature',
};

const BINARY_ROLES: Record<string, Role> = {
  child_lock: 'childLock',
};

const ENUM_ROLES: Record<string, Role> = {
  system_mode: 'thermostatMode',
  action: 'action',
};

/**
 * Decides what a property is, or nothing if HomeKit has no equivalent.
 *
 * Matching is on the source independent `semantic` name rather than the wire
 * key, so an endpoint suffixed `state_l1` is still recognised as power.
 */
export function roleFor(property: NormalisedProperty): Role | undefined {
  const semantic = property.semantic;
  if (!semantic) {
    return undefined;
  }

  switch (property.type) {
    case 'binary':
      if (semantic === 'state' && property.access.writable && property.access.readable) {
        return 'power';
      }
      return matched(BINARY_ROLES[semantic], property);
    case 'numeric':
      return matched(NUMERIC_ROLES[semantic], property);
    case 'enum':
      return matched(ENUM_ROLES[semantic], property);
    default:
      return undefined;
  }
}

/** Roles that only make sense if the value can actually be read back. */
function matched(role: Role | undefined, property: NormalisedProperty): Role | undefined {
  if (!role || !property.access.readable) {
    return undefined;
  }
  // Anything writable in HomeKit has to be writable on the wire too.
  if ((role === 'targetTemperature' || role === 'thermostatMode') && !property.access.writable) {
    return undefined;
  }
  return role;
}

/** True when the property can become part of a HomeKit accessory. */
export function isPublishable(property: NormalisedProperty): boolean {
  return roleFor(property) !== undefined;
}

/* Buttons ---------------------------------------------------------------- */

/** HomeKit knows three gestures per button and nothing else. */
export const SINGLE_PRESS = 0;
export const DOUBLE_PRESS = 1;
export const LONG_PRESS = 2;

const GESTURES: Record<string, number> = {
  single: SINGLE_PRESS,
  press: SINGLE_PRESS,
  click: SINGLE_PRESS,
  toggle: SINGLE_PRESS,
  double: DOUBLE_PRESS,
  hold: LONG_PRESS,
  long: LONG_PRESS,
};

export interface ButtonAction {
  /** The wire value, for instance `double_left`. */
  value: string;
  /** Button it belongs to, for instance `left`. */
  button: string;
  /** HomeKit event, or undefined when HomeKit has no equivalent gesture. */
  event?: number;
}

/**
 * Splits action values into buttons and gestures.
 *
 * Zigbee2MQTT names these consistently enough to infer, which saves mapping a
 * dozen strings by hand for something like a double rocker. Gestures HomeKit
 * does not have, `triple` and `release`, are reported with no event so the
 * interface can say so rather than silently dropping them.
 */
export function parseActions(values: readonly (string | number)[]): ButtonAction[] {
  return values.map((raw) => {
    const value = String(raw);
    const parts = value.split('_');

    if (parts.length > 1) {
      const first = parts[0]!.toLowerCase();
      if (first in GESTURES || isKnownUnsupported(first)) {
        return {
          value,
          button: parts.slice(1).join('_'),
          event: GESTURES[first],
        };
      }

      const last = parts[parts.length - 1]!.toLowerCase();
      if (last in GESTURES || isKnownUnsupported(last)) {
        return {
          value,
          button: parts.slice(0, -1).join('_'),
          event: GESTURES[last],
        };
      }
    }

    // No recognisable gesture, so treat the whole thing as its own button.
    return { value, button: value, event: SINGLE_PRESS };
  });
}

/** Gestures we can name but HomeKit cannot express. */
function isKnownUnsupported(word: string): boolean {
  return word === 'triple' || word === 'release';
}

/** Buttons in a stable order, each with the actions that trigger it. */
export function buttonsFrom(values: readonly (string | number)[]): Map<string, ButtonAction[]> {
  const buttons = new Map<string, ButtonAction[]>();
  for (const action of parseActions(values)) {
    const existing = buttons.get(action.button);
    if (existing) {
      existing.push(action);
    } else {
      buttons.set(action.button, [action]);
    }
  }
  return buttons;
}
