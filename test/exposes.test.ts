import { describe, expect, it } from 'vitest';

import { flattenExposes } from '../src/adapters/zigbee2mqtt/exposes.js';
import type { Z2mDevice } from '../src/adapters/zigbee2mqtt/protocol.js';
import type { NormalisedProperty } from '../src/model/types.js';
import fixture from './fixtures/bridge-devices.json' with { type: 'json' };

const devices = fixture as unknown as Z2mDevice[];

function flatten(friendlyName: string): NormalisedProperty[] {
  const device = devices.find((candidate) => candidate.friendly_name === friendlyName);
  if (!device?.definition?.exposes) {
    throw new Error(`fixture has no exposes for ${friendlyName}`);
  }
  return flattenExposes(device.definition.exposes, {
    stateTopic: `zigbee2mqtt/${friendlyName}`,
    setTopic: `zigbee2mqtt/${friendlyName}/set`,
  }).properties;
}

function byKey(properties: NormalisedProperty[], key: string): NormalisedProperty {
  const property = properties.find((candidate) => candidate.key === key);
  if (!property) {
    throw new Error(`no property ${key} in ${properties.map((p) => p.key).join(', ')}`);
  }
  return property;
}

describe('dual endpoint switch', () => {
  const properties = flatten('living_room_switch-ZB2GS');

  it('flattens every property exactly once', () => {
    expect(properties.map((property) => property.key)).toEqual([
      'state_l1',
      'state_l2',
      'power_on_behavior_l1',
      'detach_relay_mode.detach_relay_outlet1',
      'detach_relay_mode.detach_relay_outlet2',
      'action',
      'linkquality',
    ]);
  });

  it('keeps the endpoint so the two channels stay separable', () => {
    expect(byKey(properties, 'state_l1').endpoint).toBe('l1');
    expect(byKey(properties, 'state_l2').endpoint).toBe('l2');
    expect(byKey(properties, 'state_l1').group).toBe('switch');
  });

  it('reads access bits into readable and writable', () => {
    const state = byKey(properties, 'state_l1');
    expect(state.access).toEqual({ readable: true, writable: true });
    expect(state.setTopic).toBe('zigbee2mqtt/living_room_switch-ZB2GS/set');
  });

  it('gives read only properties no set topic', () => {
    const action = byKey(properties, 'action');
    expect(action.access).toEqual({ readable: true, writable: false });
    expect(action.setTopic).toBeUndefined();
  });

  it('carries the binary wire values', () => {
    const state = byKey(properties, 'state_l1');
    expect(state.onValue).toBe('ON');
    expect(state.offValue).toBe('OFF');
    expect(state.toggleValue).toBe('TOGGLE');
  });

  it('categorises config and diagnostic properties', () => {
    expect(byKey(properties, 'state_l1').category).toBe('primary');
    expect(byKey(properties, 'power_on_behavior_l1').category).toBe('config');
    expect(byKey(properties, 'action').category).toBe('diagnostic');
  });

  it('nests composite features under the composite property', () => {
    const detach = byKey(properties, 'detach_relay_mode.detach_relay_outlet1');
    expect(detach.extract).toEqual(['detach_relay_mode', 'detach_relay_outlet1']);
    expect(detach.group).toBe('Detach relay mode');
    expect(detach.access).toEqual({ readable: false, writable: true });
  });
});

describe('dimmer light', () => {
  const properties = flatten('kitchen_dimmer-candeo');

  it('keeps specific type features flat in the payload', () => {
    expect(byKey(properties, 'state').extract).toEqual(['state']);
    expect(byKey(properties, 'brightness').extract).toEqual(['brightness']);
    expect(byKey(properties, 'state').group).toBe('light');
  });

  it('nests a composite that sits inside a specific type', () => {
    const onLevel = byKey(properties, 'level_config.on_level');
    expect(onLevel.extract).toEqual(['level_config', 'on_level']);
    expect(onLevel.group).toBe('Level config');
  });

  it('carries the numeric range', () => {
    const brightness = byKey(properties, 'brightness');
    expect(brightness.min).toBe(0);
    expect(brightness.max).toBe(254);
    expect(brightness.semantic).toBe('brightness');
  });

  it('treats a write only enum as not readable', () => {
    expect(byKey(properties, 'effect').access).toEqual({ readable: false, writable: true });
  });
});

describe('climate sensor', () => {
  const properties = flatten('living_room_climate-w100');

  it('groups climate features', () => {
    expect(byKey(properties, 'system_mode').group).toBe('climate');
    expect(byKey(properties, 'occupied_heating_setpoint').group).toBe('climate');
    expect(byKey(properties, 'temperature').group).toBeUndefined();
  });

  it('handles access 5, published and gettable but not settable', () => {
    expect(byKey(properties, 'local_temperature').access).toEqual({
      readable: true,
      writable: false,
    });
  });

  it('handles access 3, published and settable', () => {
    expect(byKey(properties, 'external_temperature').access).toEqual({
      readable: true,
      writable: true,
    });
  });

  it('keeps enum values and units', () => {
    expect(byKey(properties, 'system_mode').values).toEqual(['off', 'heat', 'cool', 'auto']);
    expect(byKey(properties, 'occupied_heating_setpoint').unit).toBe('°C');
    expect(byKey(properties, 'occupied_heating_setpoint').step).toBe(0.5);
  });

  it('supports text properties', () => {
    expect(byKey(properties, 'PMTSD_from_W100_Data').type).toBe('text');
  });

  it('keeps the full action list for the button mapper', () => {
    expect(byKey(properties, 'action').values).toContain('double_center');
    expect(byKey(properties, 'action').values).toHaveLength(13);
  });
});

describe('unhandled expose types', () => {
  it('reports them instead of failing', () => {
    const result = flattenExposes(
      [
        { type: 'list', name: 'schedule', property: 'schedule', access: 1 },
        { type: 'binary', name: 'state', property: 'state', access: 7 },
      ],
      { stateTopic: 'a', setTopic: 'a/set' },
    );
    expect(result.properties.map((property) => property.key)).toEqual(['state']);
    expect(result.unsupported).toEqual(['list']);
  });
});
