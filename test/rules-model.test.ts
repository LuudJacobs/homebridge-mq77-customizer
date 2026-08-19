import { describe, expect, it } from 'vitest';

import { describeMatch, matches } from '../src/rules/match.js';
import { parseRule } from '../src/rules/validate.js';

describe('matches', () => {
  it('tests equality leniently across the forms publishers use', () => {
    // One publisher sends "ON", another true, another 1. A rule written
    // against one should not stop working when the device is replaced.
    expect(matches({ kind: 'equals', value: 'ON' }, 'on')).toBe(true);
    expect(matches({ kind: 'equals', value: 21 }, '21')).toBe(true);
    expect(matches({ kind: 'equals', value: true }, 'TRUE')).toBe(true);
    expect(matches({ kind: 'equals', value: 'ON' }, 'OFF')).toBe(false);
  });

  it('does not treat missing values as equal', () => {
    expect(matches({ kind: 'equals', value: 'ON' }, undefined)).toBe(false);
    expect(matches({ kind: 'changed' }, undefined, undefined)).toBe(false);
  });

  it('detects a change', () => {
    expect(matches({ kind: 'changed' }, 'ON', 'OFF')).toBe(true);
    expect(matches({ kind: 'changed' }, 'ON', 'ON')).toBe(false);
    expect(matches({ kind: 'changed' }, 'ON', undefined)).toBe(true);
  });

  it('separates becoming a value from already being it', () => {
    expect(matches({ kind: 'changedTo', value: 'ON' }, 'ON', 'OFF')).toBe(true);
    expect(matches({ kind: 'changedTo', value: 'ON' }, 'ON', 'ON')).toBe(false);
  });

  it('compares numbers, including ones sent as strings', () => {
    expect(matches({ kind: 'above', value: 20 }, 21.5)).toBe(true);
    expect(matches({ kind: 'above', value: 20 }, '21.5')).toBe(true);
    expect(matches({ kind: 'above', value: 20 }, 20)).toBe(false);
    expect(matches({ kind: 'below', value: 20 }, 19)).toBe(true);
    expect(matches({ kind: 'below', value: 20 }, 'warm')).toBe(false);
  });

  it('describes itself for the run log', () => {
    expect(describeMatch({ kind: 'changed' })).toBe('changes');
    expect(describeMatch({ kind: 'changedTo', value: 'ON' })).toBe('becomes "ON"');
    expect(describeMatch({ kind: 'above', value: 20 })).toBe('rises above 20');
  });
});

const trigger = {
  sourceId: 'zigbee',
  deviceId: '0xabc',
  propertyKey: 'action',
  match: { kind: 'equals', value: 'single_left' },
};
const action = { sourceId: 'zigbee', deviceId: '0xdef', propertyKey: 'state', value: 'ON' };

describe('parseRule', () => {
  it('reads a rule stored before mirrors existed as an automation', () => {
    // Rules saved by earlier versions carry no kind at all. They must keep
    // working and land on the automation tab rather than needing converting.
    const parsed = parseRule({ name: 'Old rule', trigger, actions: [action] }, 'r1');
    expect('rule' in parsed && parsed.rule.kind).toBeUndefined();
    expect('rule' in parsed && 'trigger' in parsed.rule).toBe(true);
  });

  it('accepts a complete rule', () => {
    const parsed = parseRule({ name: 'Lamp', trigger, actions: [action] }, 'r1');
    expect('rule' in parsed && parsed.rule).toMatchObject({
      id: 'r1',
      name: 'Lamp',
      enabled: true,
      conditions: [],
    });
  });

  it('refuses a rule that could never do anything', () => {
    // Storing these half understood would leave a rule that silently never
    // runs, which is harder to notice than a refusal to save.
    expect(parseRule({ trigger, actions: [action] }, 'r1')).toEqual({ error: 'A rule needs a name' });
    expect(parseRule({ name: 'x', trigger, actions: [] }, 'r1')).toEqual({
      error: 'A rule needs at least one action',
    });
    expect(parseRule({ name: 'x', actions: [action] }, 'r1')).toEqual({
      error: 'The trigger needs a device and a function',
    });
  });

  it('refuses a test it does not understand', () => {
    const bad = { ...trigger, match: { kind: 'sortOf', value: 1 } };
    expect(parseRule({ name: 'x', trigger: bad, actions: [action] }, 'r1')).toEqual({
      error: 'Trigger: unknown test',
    });
  });

  it('insists on a number where one is needed', () => {
    const bad = { ...trigger, match: { kind: 'above', value: 'warm' } };
    expect(parseRule({ name: 'x', trigger: bad, actions: [action] }, 'r1')).toEqual({
      error: 'Trigger: above needs a number',
    });
  });

  it('drops a match value that is not needed', () => {
    const parsed = parseRule(
      { name: 'x', trigger: { ...trigger, match: { kind: 'changed', value: 'junk' } }, actions: [action] },
      'r1',
    );
    expect('rule' in parsed && parsed.rule.trigger.match).toEqual({ kind: 'changed' });
  });

  it('keeps delays and rate limits within something sane', () => {
    const parsed = parseRule(
      {
        name: 'x',
        trigger,
        actions: [{ ...action, delayMs: 99_999_999 }],
        rateLimitMs: -5,
      },
      'r1',
    );
    expect('rule' in parsed && parsed.rule.actions[0]?.delayMs).toBe(3_600_000);
    expect('rule' in parsed && parsed.rule.rateLimitMs).toBe(0);
  });

  it('accepts an action that copies the trigger instead of naming a value', () => {
    const parsed = parseRule(
      {
        name: 'Follow',
        trigger,
        actions: [{ sourceId: 'a', deviceId: 'b', propertyKey: 'c', valueFrom: { kind: 'trigger' } }],
      },
      'r1',
    );
    expect('rule' in parsed && parsed.rule.actions[0]).toEqual({
      sourceId: 'a',
      deviceId: 'b',
      propertyKey: 'c',
      valueFrom: { kind: 'trigger' },
    });
  });

  it('refuses a value source it does not know', () => {
    const parsed = parseRule(
      {
        name: 'x',
        trigger,
        actions: [{ sourceId: 'a', deviceId: 'b', propertyKey: 'c', valueFrom: { kind: 'guess' } }],
      },
      'r1',
    );
    expect(parsed).toEqual({ error: 'An action needs a value to send' });
  });

  it('refuses an action with nothing to send', () => {
    const parsed = parseRule(
      { name: 'x', trigger, actions: [{ sourceId: 'a', deviceId: 'b', propertyKey: 'c' }] },
      'r1',
    );
    expect(parsed).toEqual({ error: 'An action needs a value to send' });
  });
});
