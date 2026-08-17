import type { PropertyType } from '../../model/types.js';

export interface KnownKey {
  type: PropertyType;
  label: string;
  /** Only ever writable when the source declares a command topic suffix. */
  writable: boolean;
  unit?: string;
  min?: number;
  max?: number;
}

/**
 * Keys that carry a known meaning, shared by every flat JSON publisher.
 *
 * The names come from the plugins in use rather than from any standard, so
 * this grows a line at a time. Anything absent still becomes a property, it
 * just has no HomeKit equivalent and stays available to the rules engine.
 */
export const KNOWN_KEYS: Record<string, KnownKey> = {
  state: { type: 'binary', label: 'State', writable: true },
  level: { type: 'numeric', label: 'Level', writable: true, min: 0, max: 100 },
  speed: { type: 'numeric', label: 'Speed', writable: true, min: 0, max: 100 },
  swing: { type: 'binary', label: 'Swing', writable: true },
  temperature: { type: 'numeric', label: 'Temperature', writable: false, unit: '°C' },
  humidity: { type: 'numeric', label: 'Humidity', writable: false, unit: '%', min: 0, max: 100 },
  co2_levels: { type: 'numeric', label: 'CO2', writable: false, unit: 'ppm' },
};

/**
 * Falls back to the shape of the value itself for a key we do not recognise.
 *
 * Guessing from one sample is imperfect, but dropping the key would be worse:
 * it would vanish from the interface and from the rules engine along with it.
 */
export function inferType(value: unknown): PropertyType | undefined {
  switch (typeof value) {
    case 'boolean':
      return 'binary';
    case 'number':
      return Number.isFinite(value) ? 'numeric' : undefined;
    case 'string':
      return 'text';
    default:
      // Nested objects and arrays need a path, which this adapter does not do.
      return undefined;
  }
}

/** Turns a key into something readable, `co2_levels` becoming `Co2 levels`. */
export function labelFor(key: string): string {
  const spaced = key.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
