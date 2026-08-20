import { describe, expect, it } from 'vitest';

import { describe as describeNode, evaluate, fromConditions } from '../src/rules/conditions.js';
import type { ConditionNode, PropertyRef } from '../src/rules/types.js';
import type { NormalisedProperty } from '../src/model/types.js';
import { parseRule } from '../src/rules/validate.js';

/** Every test names a device whose single property holds the given value. */
function world(values: Record<string, unknown>) {
  return {
    property: (ref: PropertyRef): NormalisedProperty | undefined =>
      ref.deviceId in values
        ? ({
            key: ref.propertyKey,
            label: ref.deviceId.toUpperCase(),
            type: 'binary',
            access: { readable: true, writable: false },
            category: 'primary' as const,
            stateTopic: 't',
            extract: [ref.propertyKey],
          } as NormalisedProperty)
        : undefined,
    value: (ref: PropertyRef) => values[ref.deviceId],
  };
}

const test = (device: string, value: string | number | boolean = 'ON'): ConditionNode => ({
  kind: 'test',
  sourceId: 'z',
  deviceId: device,
  propertyKey: 'state',
  match: { kind: 'equals', value },
});

const all = (...nodes: ConditionNode[]): ConditionNode => ({ kind: 'all', nodes });
const any = (...nodes: ConditionNode[]): ConditionNode => ({ kind: 'any', nodes });
const not = (node: ConditionNode): ConditionNode => ({ kind: 'not', node });

const holds = (node: ConditionNode, values: Record<string, unknown>) =>
  evaluate(node, world(values)) === undefined;

describe('and', () => {
  it('needs every part', () => {
    expect(holds(all(test('a'), test('b')), { a: 'ON', b: 'ON' })).toBe(true);
    expect(holds(all(test('a'), test('b')), { a: 'ON', b: 'OFF' })).toBe(false);
  });
});

describe('or', () => {
  it('needs one part', () => {
    expect(holds(any(test('a'), test('b')), { a: 'OFF', b: 'ON' })).toBe(true);
    expect(holds(any(test('a'), test('b')), { a: 'OFF', b: 'OFF' })).toBe(false);
  });

  it('says what every branch had against it', () => {
    const reason = evaluate(any(test('a'), test('b')), world({ a: 'OFF', b: 'OFF' }));
    expect(reason?.detail).toContain('none held');
  });
});

describe('not', () => {
  it('turns a group inside out', () => {
    expect(holds(not(test('a')), { a: 'OFF' })).toBe(true);
    expect(holds(not(test('a')), { a: 'ON' })).toBe(false);
    expect(holds(not(all(test('a'), test('b'))), { a: 'ON', b: 'OFF' })).toBe(true);
  });

  it('expresses what a single test cannot', () => {
    const above: ConditionNode = {
      kind: 'test',
      sourceId: 'z',
      deviceId: 'a',
      propertyKey: 'state',
      match: { kind: 'above', value: 20 },
    };
    // There is no "not above", and "below 20" is not the same at exactly 20.
    expect(holds(not(above), { a: 20 })).toBe(true);
    expect(holds(not(above), { a: 21 })).toBe(false);
  });
});

describe('the example from the request', () => {
  // (A and B) or (C and (D and E)), which flattens to two levels.
  const expression = any(all(test('a'), test('b')), all(test('c'), test('d'), test('e')));

  it('holds when the left side does', () => {
    expect(holds(expression, { a: 'ON', b: 'ON', c: 'OFF', d: 'OFF', e: 'OFF' })).toBe(true);
  });

  it('holds when the right side does', () => {
    expect(holds(expression, { a: 'OFF', b: 'ON', c: 'ON', d: 'ON', e: 'ON' })).toBe(true);
  });

  it('does not hold when neither side is complete', () => {
    expect(holds(expression, { a: 'ON', b: 'OFF', c: 'ON', d: 'ON', e: 'OFF' })).toBe(false);
  });

  it('reads back in words', () => {
    // Without a lookup the property key stands in for a label.
    expect(describeNode(expression)).toBe(
      'state is "ON" and state is "ON" or state is "ON" and state is "ON" and state is "ON"',
    );
  });

  it('names the devices when it can', () => {
    expect(describeNode(all(test('a'), test('b')), world({ a: 'ON', b: 'ON' }))).toBe(
      'A is "ON" and B is "ON"',
    );
  });
});

describe('missing values', () => {
  it('does not hold, and says so', () => {
    const reason = evaluate(test('a'), world({}));
    expect(reason?.detail).toContain('not on that device any more');

    const unknown = evaluate(test('a'), world({ a: undefined }));
    expect(unknown?.detail).toContain('no value known yet');
  });
});

describe('reading what earlier versions stored', () => {
  it('treats a flat list as all of them', () => {
    const node = fromConditions([
      { sourceId: 'z', deviceId: 'a', propertyKey: 'state', match: { kind: 'equals', value: 'ON' } },
      { sourceId: 'z', deviceId: 'b', propertyKey: 'state', match: { kind: 'equals', value: 'ON' } },
    ]);
    expect(node?.kind).toBe('all');
    expect(holds(node!, { a: 'ON', b: 'ON' })).toBe(true);
    expect(holds(node!, { a: 'ON', b: 'OFF' })).toBe(false);
  });

  it('has nothing to say about an empty list', () => {
    expect(fromConditions([])).toBeUndefined();
    expect(fromConditions(undefined)).toBeUndefined();
  });
});

const trigger = {
  sourceId: 'z',
  deviceId: 'a',
  propertyKey: 'action',
  match: { kind: 'equals', value: 'single' },
};
const action = { sourceId: 'z', deviceId: 'b', propertyKey: 'state', value: 'ON' };

describe('parsing an expression', () => {
  const parse = (when: unknown) => parseRule({ name: 'x', trigger, when, actions: [action] }, 'r1');

  it('accepts a nested one', () => {
    const parsed = parse(any(all(test('a'), test('b')), test('c')));
    expect('rule' in parsed && parsed.rule.when?.kind).toBe('any');
  });

  it('drops a group with nothing in it', () => {
    // A half built group would otherwise read as a test that always holds.
    const parsed = parse(any(all(), test('c')));
    expect('rule' in parsed && (parsed.rule.when as { nodes: unknown[] }).nodes).toHaveLength(1);
  });

  it('drops the expression entirely when nothing is left', () => {
    const parsed = parse(any(all(), all()));
    expect('rule' in parsed && parsed.rule.when).toBeUndefined();
  });

  it('refuses a test it cannot make sense of', () => {
    expect(parse({ kind: 'test', sourceId: 'z', deviceId: 'a' })).toEqual({
      error: 'Condition: a test needs a device and a function',
    });
    expect(parse({ kind: 'sometimes' })).toEqual({ error: 'Condition: unknown condition "sometimes"' });
  });

  it('still reads a stored flat list', () => {
    const parsed = parseRule(
      { name: 'x', trigger, conditions: [{ ...test('a'), kind: undefined }], actions: [action] },
      'r1',
    );
    expect('rule' in parsed && parsed.rule.when?.kind).toBe('all');
  });
});
