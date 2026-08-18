import type { Match } from './types.js';

/**
 * Tests a value against a match.
 *
 * `previous` is only needed by the kinds that care about a change, and is
 * undefined when nothing has been seen before.
 */
export function matches(match: Match, value: unknown, previous?: unknown): boolean {
  switch (match.kind) {
    case 'changed':
      return !same(value, previous);

    case 'equals':
      return same(value, match.value);

    case 'notEquals':
      return !same(value, match.value);

    case 'changedTo':
      // Distinguishes a light turning on from a light saying it is still on,
      // which Zigbee2MQTT does on every message it sends.
      return same(value, match.value) && !same(previous, match.value);

    case 'above': {
      const number = asNumber(value);
      return number !== undefined && number > match.value;
    }

    case 'below': {
      const number = asNumber(value);
      return number !== undefined && number < match.value;
    }

    default:
      return false;
  }
}

/** Describes a match in words, for the run log and the interface. */
export function describeMatch(match: Match): string {
  switch (match.kind) {
    case 'changed':
      return 'changes';
    case 'equals':
      return `is ${format(match.value)}`;
    case 'notEquals':
      return `is not ${format(match.value)}`;
    case 'changedTo':
      return `becomes ${format(match.value)}`;
    case 'above':
      return `rises above ${match.value}`;
    case 'below':
      return `falls below ${match.value}`;
    default:
      return 'matches';
  }
}

/**
 * Compares wire values leniently.
 *
 * Publishers are inconsistent about whether on/off is a string or a boolean
 * and whether a reading is a number or a string, and a rule written against
 * one form should not silently stop matching when the other turns up.
 */
function same(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (a === undefined || b === undefined || a === null || b === null) {
    return false;
  }
  const left = asNumber(a);
  const right = asNumber(b);
  if (left !== undefined && right !== undefined) {
    return left === right;
  }
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function format(value: string | number | boolean): string {
  return typeof value === 'string' ? `"${value}"` : String(value);
}
