import { describe, expect, it } from 'vitest';

import { isMissing, mergeDeep, readPath, writePath } from '../src/model/payload.js';

describe('readPath', () => {
  it('returns the payload itself for an empty path', () => {
    expect(readPath({ a: 1 }, [])).toEqual({ a: 1 });
  });

  it('reads nested values', () => {
    expect(readPath({ level_config: { on_level: 12 } }, ['level_config', 'on_level'])).toBe(12);
  });

  it('marks absent keys as missing rather than undefined', () => {
    expect(isMissing(readPath({ a: 1 }, ['b']))).toBe(true);
    expect(isMissing(readPath({ a: undefined }, ['a']))).toBe(false);
    expect(isMissing(readPath({ a: null }, ['a']))).toBe(false);
  });

  it('stops at non objects', () => {
    expect(isMissing(readPath({ a: 5 }, ['a', 'b']))).toBe(true);
    expect(isMissing(readPath(null, ['a']))).toBe(true);
    expect(isMissing(readPath([1, 2], ['0']))).toBe(true);
  });
});

describe('writePath', () => {
  it('returns the value for an empty path', () => {
    expect(writePath([], 'ON')).toBe('ON');
  });

  it('builds a flat payload', () => {
    expect(writePath(['state_l1'], 'ON')).toEqual({ state_l1: 'ON' });
  });

  it('builds a nested payload for composites', () => {
    expect(writePath(['level_config', 'on_level'], 12)).toEqual({
      level_config: { on_level: 12 },
    });
  });
});

describe('mergeDeep', () => {
  it('merges nested objects instead of replacing them', () => {
    const target = { level_config: { on_level: 1, current_level_startup: 2 }, state: 'OFF' };
    mergeDeep(target, { level_config: { on_level: 9 }, state: 'ON' });
    expect(target).toEqual({
      level_config: { on_level: 9, current_level_startup: 2 },
      state: 'ON',
    });
  });
});
