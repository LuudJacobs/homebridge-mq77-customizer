import type { NormalisedProperty } from '../model/types.js';
import type { Role } from './roles.js';

export type CharacteristicKind =
  | 'On'
  | 'Brightness'
  | 'LockPhysicalControls'
  | 'CurrentTemperature'
  | 'TargetTemperature'
  | 'CurrentHeatingCoolingState'
  | 'TargetHeatingCoolingState'
  | 'CurrentRelativeHumidity'
  | 'BatteryLevel'
  | 'StatusLowBattery'
  | 'ProgrammableSwitchEvent'
  | 'ServiceLabelIndex';

/** Reported as low below this, which is what HomeKit shows as a battery warning. */
export const LOW_BATTERY_PERCENT = 20;

export const HEATING_COOLING = { OFF: 0, HEAT: 1, COOL: 2, AUTO: 3 } as const;

/** Zigbee2MQTT's `system_mode` values, which HomeKit numbers differently. */
const MODE_TO_HOMEKIT: Record<string, number> = {
  off: HEATING_COOLING.OFF,
  heat: HEATING_COOLING.HEAT,
  cool: HEATING_COOLING.COOL,
  auto: HEATING_COOLING.AUTO,
};

/** Values of the other properties on the same service, for derived readings. */
export type Siblings = Partial<Record<Role, { property: NormalisedProperty; value: unknown }>>;

/**
 * Converts a wire value into what HomeKit expects.
 *
 * Returns undefined when the value cannot be represented, which the caller
 * treats as "not known yet" rather than guessing.
 */
export function toHomeKit(
  kind: CharacteristicKind,
  property: NormalisedProperty,
  value: unknown,
  siblings: Siblings = {},
): boolean | number | undefined {
  switch (kind) {
    case 'On':
      return toBoolean(property, value);

    case 'LockPhysicalControls':
      return toBoolean(property, value) ? 1 : 0;

    case 'Brightness':
      return toPercent(property, value);

    case 'BatteryLevel':
      return clamp(asNumber(value), 0, 100);

    case 'StatusLowBattery': {
      const level = asNumber(value);
      return level === undefined ? undefined : level < LOW_BATTERY_PERCENT ? 1 : 0;
    }

    case 'CurrentRelativeHumidity':
      return clamp(asNumber(value), 0, 100);

    case 'CurrentTemperature':
      // HomeKit's own limits. A device reporting outside them would otherwise
      // be rejected outright rather than clipped.
      return clamp(asNumber(value), -270, 100);

    case 'TargetTemperature':
      return clamp(asNumber(value), property.min ?? 10, property.max ?? 38);

    case 'TargetHeatingCoolingState':
      return MODE_TO_HOMEKIT[String(value).toLowerCase()];

    case 'CurrentHeatingCoolingState':
      return currentHeatingCooling(String(value).toLowerCase(), siblings);

    default:
      return undefined;
  }
}

/** Converts a HomeKit value back into what the device expects on the wire. */
export function fromHomeKit(
  kind: CharacteristicKind,
  property: NormalisedProperty,
  value: boolean | number | string,
): unknown {
  switch (kind) {
    case 'On':
      return fromBoolean(property, value === true);

    case 'LockPhysicalControls':
      return fromBoolean(property, Number(value) === 1);

    case 'Brightness':
      return fromPercent(property, Number(value));

    case 'TargetTemperature':
      return roundToStep(Number(value), property.step);

    case 'TargetHeatingCoolingState': {
      const name = Object.entries(MODE_TO_HOMEKIT).find(([, code]) => code === Number(value))?.[0];
      // Only offer a mode the device actually declares, so a HomeKit control
      // showing more options than the device has cannot send a rejected value.
      return name && property.values?.includes(name) ? name : undefined;
    }

    default:
      return undefined;
  }
}

/**
 * HomeKit has no "auto" for the current state, only what the device is doing.
 *
 * With an explicit heat or cool mode the answer is that mode. On auto it has
 * to be inferred from whether the room is below its setpoint.
 */
function currentHeatingCooling(mode: string, siblings: Siblings): number {
  if (mode === 'off') {
    return HEATING_COOLING.OFF;
  }
  if (mode === 'heat') {
    return HEATING_COOLING.HEAT;
  }
  if (mode === 'cool') {
    return HEATING_COOLING.COOL;
  }

  const current = asNumber(siblings.localTemperature?.value);
  const target = asNumber(siblings.targetTemperature?.value);
  if (current === undefined || target === undefined) {
    return HEATING_COOLING.OFF;
  }
  return current < target ? HEATING_COOLING.HEAT : HEATING_COOLING.OFF;
}

/** Reads a wire value as a boolean, using the property's own on and off values. */
export function toBoolean(property: NormalisedProperty, value: unknown): boolean {
  if (property.onValue !== undefined && value === property.onValue) {
    return true;
  }
  if (property.offValue !== undefined && value === property.offValue) {
    return false;
  }
  // Devices are not always consistent about types, so fall back to the obvious
  // readings rather than reporting a stale value.
  if (typeof value === 'string') {
    const upper = value.toUpperCase();
    return upper === 'ON' || upper === 'TRUE' || upper === 'LOCK' || upper === 'ENABLE';
  }
  return Boolean(value);
}

/** Produces the wire value for a boolean. */
export function fromBoolean(property: NormalisedProperty, on: boolean): unknown {
  if (on) {
    return property.onValue ?? true;
  }
  return property.offValue ?? false;
}

/** Scales a device range onto HomeKit's 0 to 100, for instance brightness 0 to 254. */
export function toPercent(property: NormalisedProperty, value: unknown): number | undefined {
  const raw = asNumber(value);
  if (raw === undefined) {
    return undefined;
  }
  const min = property.min ?? 0;
  const max = property.max ?? 100;
  if (max <= min) {
    return clamp(raw, 0, 100);
  }
  return clamp(Math.round(((raw - min) / (max - min)) * 100), 0, 100);
}

/** The reverse of `toPercent`. */
export function fromPercent(property: NormalisedProperty, percent: number): number {
  const min = property.min ?? 0;
  const max = property.max ?? 100;
  if (max <= min) {
    return Math.round(percent);
  }
  const scaled = min + (clamp(percent, 0, 100)! / 100) * (max - min);
  return Math.round(scaled);
}

function roundToStep(value: number, step: number | undefined): number {
  if (!step || step <= 0) {
    return value;
  }
  return Math.round(value / step) * step;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function clamp(value: number | undefined, min: number, max: number): number | undefined {
  return value === undefined ? undefined : Math.min(max, Math.max(min, value));
}
