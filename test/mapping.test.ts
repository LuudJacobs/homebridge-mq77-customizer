import { describe, expect, it } from 'vitest';

import type { CatalogDevice } from '../src/catalog.js';
import { fromBoolean, isPublishable, planAccessories, toBoolean } from '../src/homekit/mapping.js';
import type { NormalisedProperty } from '../src/model/types.js';
import type { DeviceExposure } from '../src/store.js';

function property(overrides: Partial<NormalisedProperty> = {}): NormalisedProperty {
  return {
    key: 'state',
    label: 'State',
    semantic: 'state',
    type: 'binary',
    access: { readable: true, writable: true },
    category: 'primary',
    onValue: 'ON',
    offValue: 'OFF',
    stateTopic: 'zigbee2mqtt/device',
    setTopic: 'zigbee2mqtt/device/set',
    extract: ['state'],
    ...overrides,
  };
}

function device(properties: NormalisedProperty[], overrides: Partial<CatalogDevice> = {}): CatalogDevice {
  return {
    sourceId: 'zigbee',
    deviceId: '0xabc',
    name: 'Living room',
    manufacturer: 'SONOFF',
    model: 'ZB2GS',
    rulesOnly: false,
    properties,
    ...overrides,
  };
}

const dualEndpoint = [
  property({ key: 'state_l1', endpoint: 'l1', extract: ['state_l1'] }),
  property({ key: 'state_l2', endpoint: 'l2', extract: ['state_l2'] }),
];

describe('isPublishable', () => {
  it('accepts a readable writable binary', () => {
    expect(isPublishable(property())).toBe(true);
  });

  it('rejects types with no HomeKit tile in this version', () => {
    expect(isPublishable(property({ type: 'numeric' }))).toBe(false);
    expect(isPublishable(property({ type: 'enum' }))).toBe(false);
    expect(isPublishable(property({ type: 'text' }))).toBe(false);
  });

  it('rejects a binary that cannot be switched or cannot be read back', () => {
    expect(isPublishable(property({ access: { readable: true, writable: false } }))).toBe(false);
    expect(isPublishable(property({ access: { readable: false, writable: true } }))).toBe(false);
  });
});

describe('planAccessories', () => {
  it('publishes nothing without a saved selection', () => {
    expect(planAccessories(device(dualEndpoint), undefined)).toEqual([]);
  });

  it('publishes nothing when the selection is empty', () => {
    expect(planAccessories(device(dualEndpoint), { properties: [] })).toEqual([]);
  });

  it('publishes nothing for a rules only source, even when ticked', () => {
    const exposure: DeviceExposure = { properties: ['state_l1'] };
    expect(planAccessories(device(dualEndpoint, { rulesOnly: true }), exposure)).toEqual([]);
  });

  it('ignores ticked properties that have no tile', () => {
    const properties = [property({ key: 'linkquality', type: 'numeric' })];
    expect(planAccessories(device(properties), { properties: ['linkquality'] })).toEqual([]);
  });

  it('puts both endpoints on one accessory by default', () => {
    const plans = planAccessories(device(dualEndpoint), {
      properties: ['state_l1', 'state_l2'],
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]?.seed).toBe('zigbee:0xabc');
    expect(plans[0]?.services.map((service) => service.propertyKey)).toEqual([
      'state_l1',
      'state_l2',
    ]);
  });

  it('names each service when several share an accessory', () => {
    const plans = planAccessories(device(dualEndpoint), {
      properties: ['state_l1', 'state_l2'],
    });
    expect(plans[0]?.services.map((service) => service.name)).toEqual([
      'Living room l1',
      'Living room l2',
    ]);
  });

  it('splits into one accessory per endpoint when asked', () => {
    const plans = planAccessories(device(dualEndpoint), {
      properties: ['state_l1', 'state_l2'],
      splitEndpoints: true,
    });
    expect(plans.map((plan) => plan.seed)).toEqual(['zigbee:0xabc:l1', 'zigbee:0xabc:l2']);
    expect(plans.map((plan) => plan.name)).toEqual(['Living room l1', 'Living room l2']);
    expect(plans.map((plan) => plan.serial)).toEqual(['0xabc-l1', '0xabc-l2']);
  });

  it('does not split when only one endpoint ended up selected', () => {
    const plans = planAccessories(device(dualEndpoint), {
      properties: ['state_l1'],
      splitEndpoints: true,
    });
    expect(plans).toHaveLength(1);
    // Seed must stay the unsplit one, otherwise unticking the second endpoint
    // would silently orphan the accessory HomeKit already knows.
    expect(plans[0]?.seed).toBe('zigbee:0xabc');
  });

  it('gives device level properties their own accessory when split', () => {
    const properties = [...dualEndpoint, property({ key: 'child_lock', extract: ['child_lock'] })];
    const plans = planAccessories(device(properties), {
      properties: ['state_l1', 'state_l2', 'child_lock'],
      splitEndpoints: true,
    });
    expect(plans.map((plan) => plan.seed)).toEqual([
      'zigbee:0xabc:l1',
      'zigbee:0xabc:l2',
      'zigbee:0xabc:',
    ]);
    expect(plans[2]?.name).toBe('Living room');
  });

  it('uses the chosen tile type per endpoint', () => {
    const plans = planAccessories(device(dualEndpoint), {
      properties: ['state_l1', 'state_l2'],
      tileTypes: { l1: 'Fan', l2: 'Lightbulb' },
    });
    expect(plans[0]?.services.map((service) => service.tile)).toEqual(['Fan', 'Lightbulb']);
  });

  it('defaults to a switch tile', () => {
    const plans = planAccessories(device([property()]), { properties: ['state'] });
    expect(plans[0]?.services[0]?.tile).toBe('Switch');
  });

  it('honours a custom name', () => {
    const plans = planAccessories(device([property()]), {
      properties: ['state'],
      names: { '': 'Reading lamp' },
    });
    expect(plans[0]?.name).toBe('Reading lamp');
  });
});

describe('boolean conversion', () => {
  it('uses the property on and off values', () => {
    const state = property();
    expect(toBoolean(state, 'ON')).toBe(true);
    expect(toBoolean(state, 'OFF')).toBe(false);
    expect(fromBoolean(state, true)).toBe('ON');
    expect(fromBoolean(state, false)).toBe('OFF');
  });

  it('handles devices that publish real booleans', () => {
    const flag = property({ onValue: true, offValue: false });
    expect(toBoolean(flag, true)).toBe(true);
    expect(toBoolean(flag, false)).toBe(false);
    expect(fromBoolean(flag, true)).toBe(true);
  });

  it('falls back sensibly on an unexpected value', () => {
    const state = property();
    expect(toBoolean(state, 'on')).toBe(true);
    expect(toBoolean(state, 'off')).toBe(false);
    expect(toBoolean(state, 1)).toBe(true);
    expect(toBoolean(state, 0)).toBe(false);
  });

  it('defaults to plain booleans when the property declares no values', () => {
    const bare = property({ onValue: undefined, offValue: undefined });
    expect(fromBoolean(bare, true)).toBe(true);
    expect(fromBoolean(bare, false)).toBe(false);
  });
});
