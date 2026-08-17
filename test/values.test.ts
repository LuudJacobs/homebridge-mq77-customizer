import { describe, expect, it } from 'vitest';

import { fromHomeKit, toHomeKit } from '../src/homekit/values.js';
import type { NormalisedProperty } from '../src/model/types.js';

function property(overrides: Partial<NormalisedProperty> = {}): NormalisedProperty {
  return {
    key: 'state',
    label: 'State',
    type: 'binary',
    access: { readable: true, writable: true },
    category: 'primary',
    onValue: 'ON',
    offValue: 'OFF',
    stateTopic: 't',
    extract: ['state'],
    ...overrides,
  };
}

describe('on/off', () => {
  it('uses the values the device declares', () => {
    const state = property();
    expect(toHomeKit('On', state, 'ON')).toBe(true);
    expect(toHomeKit('On', state, 'OFF')).toBe(false);
    expect(fromHomeKit('On', state, true)).toBe('ON');
    expect(fromHomeKit('On', state, false)).toBe('OFF');
  });

  it('copes with devices that publish real booleans', () => {
    const flag = property({ onValue: true, offValue: false });
    expect(toHomeKit('On', flag, true)).toBe(true);
    expect(fromHomeKit('On', flag, false)).toBe(false);
  });
});

describe('brightness', () => {
  // Zigbee lights use 0 to 254, HomeKit uses a percentage.
  const brightness = property({
    key: 'brightness',
    type: 'numeric',
    min: 0,
    max: 254,
    onValue: undefined,
    offValue: undefined,
  });

  it('scales the device range onto a percentage', () => {
    expect(toHomeKit('Brightness', brightness, 0)).toBe(0);
    expect(toHomeKit('Brightness', brightness, 254)).toBe(100);
    expect(toHomeKit('Brightness', brightness, 127)).toBe(50);
  });

  it('scales back', () => {
    expect(fromHomeKit('Brightness', brightness, 0)).toBe(0);
    expect(fromHomeKit('Brightness', brightness, 100)).toBe(254);
    expect(fromHomeKit('Brightness', brightness, 50)).toBe(127);
  });

  it('survives a round trip within rounding', () => {
    for (const percent of [0, 1, 25, 33, 50, 66, 99, 100]) {
      const wire = fromHomeKit('Brightness', brightness, percent) as number;
      expect(Math.abs((toHomeKit('Brightness', brightness, wire) as number) - percent)).toBeLessThanOrEqual(1);
    }
  });

  it('clamps values outside the declared range', () => {
    expect(toHomeKit('Brightness', brightness, 999)).toBe(100);
    expect(toHomeKit('Brightness', brightness, -5)).toBe(0);
  });
});

describe('battery', () => {
  const battery = property({ key: 'battery', type: 'numeric', min: 0, max: 100 });

  it('reports the level', () => {
    expect(toHomeKit('BatteryLevel', battery, 76)).toBe(76);
  });

  it('warns below twenty percent', () => {
    expect(toHomeKit('StatusLowBattery', battery, 21)).toBe(0);
    expect(toHomeKit('StatusLowBattery', battery, 19)).toBe(1);
  });
});

describe('temperature and humidity', () => {
  const temperature = property({ key: 'temperature', type: 'numeric' });

  it('passes readings through', () => {
    expect(toHomeKit('CurrentTemperature', temperature, 21.5)).toBe(21.5);
    expect(toHomeKit('CurrentRelativeHumidity', temperature, 47)).toBe(47);
  });

  it('clips to what HomeKit accepts rather than being rejected', () => {
    expect(toHomeKit('CurrentTemperature', temperature, 5000)).toBe(100);
    expect(toHomeKit('CurrentRelativeHumidity', temperature, 120)).toBe(100);
  });

  it('reads numbers sent as strings', () => {
    expect(toHomeKit('CurrentTemperature', temperature, '21.5')).toBe(21.5);
    expect(toHomeKit('CurrentTemperature', temperature, 'warm')).toBeUndefined();
  });
});

describe('thermostat', () => {
  const mode = property({
    key: 'system_mode',
    type: 'enum',
    values: ['off', 'heat', 'cool', 'auto'],
  });
  const setpoint = property({ key: 'setpoint', type: 'numeric', min: 5, max: 30, step: 0.5 });

  it('maps the modes both ways', () => {
    expect(toHomeKit('TargetHeatingCoolingState', mode, 'off')).toBe(0);
    expect(toHomeKit('TargetHeatingCoolingState', mode, 'heat')).toBe(1);
    expect(toHomeKit('TargetHeatingCoolingState', mode, 'auto')).toBe(3);
    expect(fromHomeKit('TargetHeatingCoolingState', mode, 1)).toBe('heat');
    expect(fromHomeKit('TargetHeatingCoolingState', mode, 3)).toBe('auto');
  });

  it('refuses a mode the device does not declare', () => {
    const heatOnly = property({ key: 'system_mode', type: 'enum', values: ['off', 'heat'] });
    expect(fromHomeKit('TargetHeatingCoolingState', heatOnly, 2)).toBeUndefined();
  });

  it('reports the current state directly for explicit modes', () => {
    expect(toHomeKit('CurrentHeatingCoolingState', mode, 'off')).toBe(0);
    expect(toHomeKit('CurrentHeatingCoolingState', mode, 'heat')).toBe(1);
    expect(toHomeKit('CurrentHeatingCoolingState', mode, 'cool')).toBe(2);
  });

  it('infers the current state on auto, which HomeKit has no value for', () => {
    const siblings = {
      localTemperature: { property: setpoint, value: 18 },
      targetTemperature: { property: setpoint, value: 21 },
    };
    expect(toHomeKit('CurrentHeatingCoolingState', mode, 'auto', siblings)).toBe(1);

    const warm = {
      localTemperature: { property: setpoint, value: 22 },
      targetTemperature: { property: setpoint, value: 21 },
    };
    expect(toHomeKit('CurrentHeatingCoolingState', mode, 'auto', warm)).toBe(0);
  });

  it('says off on auto when it has no readings to compare', () => {
    expect(toHomeKit('CurrentHeatingCoolingState', mode, 'auto')).toBe(0);
  });

  it('keeps the setpoint inside the range the device declares', () => {
    expect(toHomeKit('TargetTemperature', setpoint, 3)).toBe(5);
    expect(toHomeKit('TargetTemperature', setpoint, 45)).toBe(30);
  });

  it('rounds a setpoint to the step the device accepts', () => {
    expect(fromHomeKit('TargetTemperature', setpoint, 21.3)).toBe(21.5);
    expect(fromHomeKit('TargetTemperature', setpoint, 21.1)).toBe(21);
  });
});

describe('child lock', () => {
  const lock = property({ key: 'child_lock', onValue: 'LOCK', offValue: 'UNLOCK' });

  it('maps onto the physical controls lock', () => {
    expect(toHomeKit('LockPhysicalControls', lock, 'LOCK')).toBe(1);
    expect(toHomeKit('LockPhysicalControls', lock, 'UNLOCK')).toBe(0);
    expect(fromHomeKit('LockPhysicalControls', lock, 1)).toBe('LOCK');
    expect(fromHomeKit('LockPhysicalControls', lock, 0)).toBe('UNLOCK');
  });
});
