import { describe, expect, it } from 'vitest';

import { buttonsFrom, isPublishable, parseActions, roleFor } from '../src/homekit/roles.js';
import type { NormalisedProperty } from '../src/model/types.js';

function property(overrides: Partial<NormalisedProperty> = {}): NormalisedProperty {
  return {
    key: 'state',
    label: 'State',
    semantic: 'state',
    type: 'binary',
    access: { readable: true, writable: true },
    category: 'primary',
    stateTopic: 't',
    extract: ['state'],
    ...overrides,
  };
}

describe('roleFor', () => {
  it('recognises on/off regardless of the endpoint suffix', () => {
    expect(roleFor(property({ key: 'state_l2', semantic: 'state' }))).toBe('power');
  });

  it('recognises sensors by their property name', () => {
    const numeric = { type: 'numeric' as const, access: { readable: true, writable: false } };
    expect(roleFor(property({ ...numeric, semantic: 'temperature' }))).toBe('temperature');
    expect(roleFor(property({ ...numeric, semantic: 'humidity' }))).toBe('humidity');
    expect(roleFor(property({ ...numeric, semantic: 'battery' }))).toBe('battery');
    expect(roleFor(property({ ...numeric, semantic: 'local_temperature' }))).toBe(
      'localTemperature',
    );
  });

  it('recognises the climate controls', () => {
    expect(
      roleFor(property({ type: 'enum', semantic: 'system_mode', values: ['off', 'heat'] })),
    ).toBe('thermostatMode');
    expect(roleFor(property({ type: 'numeric', semantic: 'occupied_heating_setpoint' }))).toBe(
      'targetTemperature',
    );
  });

  it('recognises buttons and child lock', () => {
    expect(roleFor(property({ type: 'enum', semantic: 'action', access: { readable: true, writable: false } }))).toBe('action');
    expect(roleFor(property({ semantic: 'child_lock' }))).toBe('childLock');
  });

  it('has nothing for functions HomeKit cannot show', () => {
    expect(roleFor(property({ type: 'enum', semantic: 'power_on_behavior' }))).toBeUndefined();
    expect(roleFor(property({ type: 'numeric', semantic: 'linkquality' }))).toBeUndefined();
    expect(roleFor(property({ type: 'text', semantic: 'PMTSD_from_W100_Data' }))).toBeUndefined();
    expect(roleFor(property({ semantic: undefined }))).toBeUndefined();
  });

  it('will not publish something it cannot read back', () => {
    expect(roleFor(property({ access: { readable: false, writable: true } }))).toBeUndefined();
    expect(
      roleFor(
        property({
          type: 'numeric',
          semantic: 'temperature',
          access: { readable: false, writable: false },
        }),
      ),
    ).toBeUndefined();
  });

  it('will not offer a climate control it cannot set', () => {
    expect(
      roleFor(
        property({
          type: 'numeric',
          semantic: 'occupied_heating_setpoint',
          access: { readable: true, writable: false },
        }),
      ),
    ).toBeUndefined();
  });

  it('agrees with isPublishable', () => {
    expect(isPublishable(property())).toBe(true);
    expect(isPublishable(property({ type: 'numeric', semantic: 'linkquality' }))).toBe(false);
  });
});

describe('parseActions', () => {
  it('splits the Aqara rocker into buttons and gestures', () => {
    const actions = parseActions(['single_left', 'double_left', 'hold_left', 'triple_left']);
    expect(actions.map((action) => action.button)).toEqual(['left', 'left', 'left', 'left']);
    expect(actions.map((action) => action.event)).toEqual([0, 1, 2, undefined]);
  });

  it('handles the W100 naming', () => {
    const actions = parseActions(['single_center', 'double_minus', 'hold_plus', 'release_plus']);
    expect(actions.map((action) => action.button)).toEqual([
      'center',
      'minus',
      'plus',
      'plus',
    ]);
    expect(actions.map((action) => action.event)).toEqual([0, 1, 2, undefined]);
  });

  it('handles a gesture that trails the button name', () => {
    const actions = parseActions(['left_hold', 'right_single']);
    expect(actions.map((action) => action.button)).toEqual(['left', 'right']);
    expect(actions.map((action) => action.event)).toEqual([2, 0]);
  });

  it('treats an unrecognised action as its own single press button', () => {
    const actions = parseActions(['W100_PMTSD_request']);
    expect(actions[0]).toEqual({ value: 'W100_PMTSD_request', button: 'W100_PMTSD_request', event: 0 });
  });

  it('reads a toggle as a single press', () => {
    const actions = parseActions(['toggle_l1', 'toggle_l2']);
    expect(actions.map((action) => action.button)).toEqual(['l1', 'l2']);
    expect(actions.map((action) => action.event)).toEqual([0, 0]);
  });
});

describe('buttonsFrom', () => {
  it('groups the double rocker into three buttons', () => {
    const buttons = buttonsFrom([
      'single_left', 'single_right', 'single_both',
      'double_left', 'double_right', 'double_both',
      'triple_left', 'triple_right', 'triple_both',
      'hold_left', 'hold_right', 'hold_both',
    ]);
    expect([...buttons.keys()]).toEqual(['left', 'right', 'both']);
    expect(buttons.get('left')).toHaveLength(4);
  });

  it('keeps the order the device declared', () => {
    const buttons = buttonsFrom(['hold_plus', 'single_minus', 'single_plus']);
    expect([...buttons.keys()]).toEqual(['plus', 'minus']);
  });
});
