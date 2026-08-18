/** Reading and writing values at a path inside a JSON payload. */

const MISSING = Symbol('missing');

/**
 * Reads the value at `path`. An empty path returns the payload itself.
 * Returns the `missing` marker when any level is absent, so a stored `null`
 * or `undefined` stays distinguishable from "not in this message".
 */
export function readPath(payload: unknown, path: string[]): unknown | typeof MISSING {
  let current: unknown = payload;
  for (const segment of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return MISSING;
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return MISSING;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function isMissing(value: unknown): value is typeof MISSING {
  return value === MISSING;
}

/** Builds a payload containing just `value` at `path`. */
export function writePath(path: string[], value: unknown): unknown {
  if (path.length === 0) {
    return value;
  }
  const root: Record<string, unknown> = {};
  let current = root;
  for (let i = 0; i < path.length - 1; i++) {
    const next: Record<string, unknown> = {};
    current[path[i]!] = next;
    current = next;
  }
  current[path[path.length - 1]!] = value;
  return root;
}

/** Merges `source` into `target` in place, recursing into plain objects. */
export function mergeDeep(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      mergeDeep(existing, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
