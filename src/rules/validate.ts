import { MAX_SETTLE_MS, MIN_SETTLE_MS } from './types.js';
import type {
  Action,
  AnyRule,
  Condition,
  Match,
  MirrorRule,
  PropertyRef,
  Rule,
  Trigger,
} from './types.js';

const MATCH_KINDS = ['changed', 'equals', 'notEquals', 'changedTo', 'above', 'below'];
const NEEDS_VALUE = ['equals', 'notEquals', 'changedTo', 'above', 'below'];
const NEEDS_NUMBER = ['above', 'below'];

/**
 * Turns whatever the interface sent into a rule, or says why it cannot.
 *
 * A malformed rule is rejected rather than stored half understood, since a
 * rule that silently does nothing is worse than one that refuses to save.
 */
export function parseRule(raw: unknown, id: string): { rule: AnyRule } | { error: string } {
  if (!isObject(raw)) {
    return { error: 'A rule must be an object' };
  }

  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 80) : '';
  if (!name) {
    return { error: 'A rule needs a name' };
  }

  if (raw.kind === 'mirror') {
    return parseMirror(raw, id, name);
  }

  const trigger = parseRef(raw.trigger);
  if (!trigger) {
    return { error: 'The trigger needs a device and a function' };
  }
  const triggerMatch = parseMatch(isObject(raw.trigger) ? raw.trigger.match : undefined);
  if ('error' in triggerMatch) {
    return { error: `Trigger: ${triggerMatch.error}` };
  }

  const conditions: Condition[] = [];
  for (const entry of asArray(raw.conditions)) {
    const ref = parseRef(entry);
    const match = parseMatch(isObject(entry) ? entry.match : undefined);
    if (!ref) {
      return { error: 'A condition needs a device and a function' };
    }
    if ('error' in match) {
      return { error: `Condition: ${match.error}` };
    }
    conditions.push({ ...ref, match: match.match });
  }

  const actions: Action[] = [];
  for (const entry of asArray(raw.actions)) {
    const ref = parseRef(entry);
    if (!ref || !isObject(entry)) {
      return { error: 'An action needs a device and a function' };
    }
    const copies =
      isObject(entry.valueFrom) && entry.valueFrom.kind === 'trigger';

    const value = entry.value;
    const literal =
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

    if (!copies && !literal) {
      return { error: 'An action needs a value to send' };
    }

    const delay = typeof entry.delayMs === 'number' ? clamp(entry.delayMs, 0, 3_600_000) : undefined;
    actions.push({
      ...ref,
      ...(copies ? { valueFrom: { kind: 'trigger' } as const } : { value: value as string | number | boolean }),
      ...(delay ? { delayMs: delay } : {}),
    });
  }

  if (actions.length === 0) {
    return { error: 'A rule needs at least one action' };
  }

  const rateLimitMs =
    typeof raw.rateLimitMs === 'number' ? clamp(raw.rateLimitMs, 0, 3_600_000) : undefined;

  return {
    rule: {
      id,
      name,
      enabled: raw.enabled !== false,
      trigger: { ...trigger, match: triggerMatch.match } as Trigger,
      conditions,
      actions,
      ...(rateLimitMs === undefined ? {} : { rateLimitMs }),
    },
  };
}

function parseMirror(
  raw: Record<string, unknown>,
  id: string,
  name: string,
): { rule: MirrorRule } | { error: string } {
  const groups: PropertyRef[][] = [];

  for (const entry of asArray(raw.groups)) {
    const refs: PropertyRef[] = [];
    for (const member of asArray(entry)) {
      const ref = parseRef(member);
      if (!ref) {
        return { error: 'Every mirrored function needs a device and a function' };
      }
      // The same property twice would make it mirror onto itself.
      if (refs.some((existing) => sameRef(existing, ref))) {
        return { error: 'A function cannot be mirrored with itself' };
      }
      refs.push(ref);
    }
    if (refs.length < 2) {
      return { error: 'Mirroring needs at least two devices' };
    }
    groups.push(refs);
  }

  // A rule being drafted has nothing in it yet, and refusing to store that
  // would leave nowhere to build it. Only a rule that is meant to be running
  // has to be complete.
  if (groups.length === 0 && raw.enabled !== false) {
    return { error: 'Pick at least one function to mirror' };
  }

  const rateLimitMs =
    typeof raw.rateLimitMs === 'number' ? clamp(raw.rateLimitMs, 0, 3_600_000) : undefined;
  const settleMs =
    typeof raw.settleMs === 'number'
      ? clamp(raw.settleMs, MIN_SETTLE_MS, MAX_SETTLE_MS)
      : undefined;

  return {
    rule: {
      id,
      kind: 'mirror',
      name,
      enabled: raw.enabled !== false,
      groups,
      ...(rateLimitMs === undefined ? {} : { rateLimitMs }),
      ...(settleMs === undefined ? {} : { settleMs }),
    },
  };
}

function sameRef(a: PropertyRef, b: PropertyRef): boolean {
  return (
    a.sourceId === b.sourceId && a.deviceId === b.deviceId && a.propertyKey === b.propertyKey
  );
}

function parseMatch(raw: unknown): { match: Match } | { error: string } {
  if (!isObject(raw) || typeof raw.kind !== 'string' || !MATCH_KINDS.includes(raw.kind)) {
    return { error: 'unknown test' };
  }
  const kind = raw.kind;

  if (!NEEDS_VALUE.includes(kind)) {
    return { match: { kind: 'changed' } };
  }

  const value = raw.value;
  if (NEEDS_NUMBER.includes(kind)) {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number)) {
      return { error: `${kind} needs a number` };
    }
    return { match: { kind, value: number } as Match };
  }

  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return { error: `${kind} needs a value` };
  }
  return { match: { kind, value } as Match };
}

function parseRef(raw: unknown): PropertyRef | undefined {
  if (!isObject(raw)) {
    return undefined;
  }
  const { sourceId, deviceId, propertyKey } = raw;
  if (
    typeof sourceId !== 'string' ||
    typeof deviceId !== 'string' ||
    typeof propertyKey !== 'string' ||
    !sourceId ||
    !deviceId ||
    !propertyKey
  ) {
    return undefined;
  }
  return { sourceId, deviceId, propertyKey };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}
