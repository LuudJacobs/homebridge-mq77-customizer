import { fromBoolean, fromPercent, toBoolean, toPercent } from '../homekit/values.js';
import type { NormalisedProperty } from '../model/types.js';

/**
 * Restates one property's value in another property's terms.
 *
 * Two devices rarely word the same thing the same way. One switch says `"ON"`,
 * another `true`; one dimmer counts to 254, another to 100. Copying the raw
 * value would half work and then quietly fail on the device that disagrees,
 * so it goes through the meaning rather than the bytes.
 *
 * These are the same conversions the HomeKit mapping uses, deliberately: a
 * rule and a HomeKit tile should not disagree about what a value means.
 */
export function convertValue(
  from: NormalisedProperty,
  to: NormalisedProperty,
  value: unknown,
): string | number | boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (from.type === 'binary' && to.type === 'binary') {
    return fromBoolean(to, toBoolean(from, value)) as string | number | boolean;
  }

  // Ranges only translate when both ends declare one. Without that, scaling
  // would be guesswork.
  if (from.type === 'numeric' && to.type === 'numeric' && hasRange(from) && hasRange(to)) {
    const percent = toPercent(from, value);
    return percent === undefined ? undefined : fromPercent(to, percent);
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  return undefined;
}

function hasRange(property: NormalisedProperty): boolean {
  return property.min !== undefined && property.max !== undefined;
}
