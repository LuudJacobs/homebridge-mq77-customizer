import { describe, expect, it } from 'vitest';

import type { CatalogDevice } from '../src/catalog.js';
import { planAccessories, type AccessoryPlan } from '../src/homekit/mapping.js';
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

function device(
  properties: NormalisedProperty[],
  overrides: Partial<CatalogDevice> = {},
): CatalogDevice {
  return {
    sourceId: 'zigbee',
    deviceId: '0xabc',
    name: 'Living room',
    manufacturer: 'SONOFF',
    model: 'ZB2GS',
    rulesOnly: false,
    renameable: false,
    properties,
    ...overrides,
  };
}

const dualEndpoint = [
  property({ key: 'state_l1', endpoint: 'l1', extract: ['state_l1'] }),
  property({ key: 'state_l2', endpoint: 'l2', extract: ['state_l2'] }),
];

const kinds = (plans: AccessoryPlan[]): string[][] =>
  plans.map((plan) => plan.services.map((service) => service.kind));

describe('selection', () => {
  it('publishes nothing without a saved selection', () => {
    expect(planAccessories(device(dualEndpoint), undefined)).toEqual([]);
  });

  it('publishes nothing for a rules only source, even when ticked', () => {
    const exposure: DeviceExposure = { properties: ['state_l1'] };
    expect(planAccessories(device(dualEndpoint, { rulesOnly: true }), exposure)).toEqual([]);
  });

  it('ignores ticked functions HomeKit has no place for', () => {
    const properties = [property({ key: 'linkquality', semantic: 'linkquality', type: 'numeric' })];
    expect(planAccessories(device(properties), { properties: ['linkquality'] })).toEqual([]);
  });
});

describe('switches', () => {
  it('puts both endpoints on one accessory by default', () => {
    const plans = planAccessories(device(dualEndpoint), {
      properties: ['state_l1', 'state_l2'],
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]?.seed).toBe('zigbee:0xabc');
    expect(kinds(plans)).toEqual([['Switch', 'Switch']]);
  });

  it('splits into one accessory per endpoint when asked', () => {
    const plans = planAccessories(device(dualEndpoint), {
      properties: ['state_l1', 'state_l2'],
      splitEndpoints: true,
    });
    expect(plans.map((plan) => plan.seed)).toEqual(['zigbee:0xabc:l1', 'zigbee:0xabc:l2']);
    expect(plans.map((plan) => plan.serial)).toEqual(['0xabc-l1', '0xabc-l2']);
  });

  it('does not split when only one endpoint ended up selected', () => {
    const plans = planAccessories(device(dualEndpoint), {
      properties: ['state_l1'],
      splitEndpoints: true,
    });
    // Seed must stay the unsplit one, otherwise unticking the second endpoint
    // would orphan the accessory HomeKit already knows.
    expect(plans[0]?.seed).toBe('zigbee:0xabc');
  });

  it('uses the chosen tile type', () => {
    const plans = planAccessories(device([property()]), {
      properties: ['state'],
      tileTypes: { '': 'Outlet' },
    });
    expect(kinds(plans)).toEqual([['Outlet']]);
  });
});

describe('lights', () => {
  const light = [
    property(),
    property({
      key: 'brightness',
      semantic: 'brightness',
      label: 'Brightness',
      type: 'numeric',
      min: 0,
      max: 254,
      extract: ['brightness'],
    }),
  ];

  it('puts brightness on the same service as on/off', () => {
    const plans = planAccessories(device(light), { properties: ['state', 'brightness'] });
    expect(plans[0]?.services).toHaveLength(1);
    expect(plans[0]?.services[0]?.bindings.map((binding) => binding.characteristic)).toEqual([
      'On',
      'Brightness',
    ]);
  });

  it('forces a Lightbulb, since brightness exists nowhere else', () => {
    const plans = planAccessories(device(light), {
      properties: ['state', 'brightness'],
      tileTypes: { '': 'Outlet' },
    });
    expect(kinds(plans)).toEqual([['Lightbulb']]);
  });

  it('leaves the tile alone when brightness is not selected', () => {
    const plans = planAccessories(device(light), {
      properties: ['state'],
      tileTypes: { '': 'Outlet' },
    });
    expect(kinds(plans)).toEqual([['Outlet']]);
  });
});

describe('renaming', () => {
  it('leaves a source that names its own devices alone', () => {
    // Zigbee2MQTT owns its names, so one given here is for the interface and
    // does not quietly rename the accessory as well.
    const plans = planAccessories(device([property()], { renameable: false }), {
      properties: ['state'],
      label: 'Reading lamp',
    });
    expect(plans[0]?.name).toBe('Living room');
  });

  it('corrects a name HomeKit would refuse, without changing the accessory', () => {
    const plans = planAccessories(device([property()], { name: 'Gang Licht (voordeur)' }), {
      properties: ['state'],
    });
    expect(plans[0]?.name).toBe('Gang Licht voordeur');
    // The identity comes from the seed, so fixing the name does not make
    // HomeKit treat it as a different accessory.
    expect(plans[0]?.seed).toBe('zigbee:0xabc');
  });

  it('corrects a name the user typed as well', () => {
    const plans = planAccessories(device([property()], { renameable: true }), {
      properties: ['state'],
      label: 'Lamp (hal)',
    });
    expect(plans[0]?.name).toBe('Lamp hal');
  });

  it('corrects the service names built from it', () => {
    const plans = planAccessories(device(dualEndpoint, { name: 'Gang (voor)' }), {
      properties: ['state_l1', 'state_l2'],
    });
    expect(plans[0]?.services.map((service) => service.name)).toEqual([
      'Gang voor l1',
      'Gang voor l2',
    ]);
  });

  it('uses the given name for the accessory', () => {
    const plans = planAccessories(device([property()], { renameable: true }), {
      properties: ['state'],
      label: 'Reading lamp',
    });
    expect(plans[0]?.name).toBe('Reading lamp');
  });

  it('falls back to the source name when the given one is blank', () => {
    const plans = planAccessories(device([property()], { renameable: true }), { properties: ['state'], label: '  ' });
    expect(plans[0]?.name).toBe('Living room');
  });

  it('carries the given name into split endpoint accessories', () => {
    const plans = planAccessories(device(dualEndpoint, { renameable: true }), {
      properties: ['state_l1', 'state_l2'],
      splitEndpoints: true,
      label: 'Hallway',
    });
    expect(plans.map((plan) => plan.name)).toEqual(['Hallway l1', 'Hallway l2']);
  });

  it('lets a per endpoint name still win', () => {
    const plans = planAccessories(device(dualEndpoint, { renameable: true }), {
      properties: ['state_l1', 'state_l2'],
      splitEndpoints: true,
      label: 'Hallway',
      names: { l1: 'Porch' },
    });
    expect(plans.map((plan) => plan.name)).toEqual(['Porch', 'Hallway l2']);
  });
});

describe('fans', () => {
  const fan = [
    property({ semantic: 'state' }),
    property({ key: 'speed', semantic: 'speed', label: 'Speed', type: 'numeric', min: 0, max: 100, extract: ['speed'] }),
    property({ key: 'swing', semantic: 'swing', label: 'Swing', type: 'binary', extract: ['swing'] }),
  ];

  it('puts speed and swing on one Fan service', () => {
    const plans = planAccessories(device(fan), { properties: ['state', 'speed', 'swing'] });
    expect(kinds(plans)).toEqual([['Fan']]);
    expect(plans[0]?.services[0]?.bindings.map((binding) => binding.characteristic)).toEqual([
      'On',
      'RotationSpeed',
      'SwingMode',
    ]);
  });

  it('forces a Fan, since speed exists nowhere else', () => {
    const plans = planAccessories(device(fan), {
      properties: ['state', 'speed'],
      tileTypes: { '': 'Outlet' },
    });
    expect(kinds(plans)).toEqual([['Fan']]);
  });

  it('leaves the tile alone when only on/off is selected', () => {
    const plans = planAccessories(device(fan), {
      properties: ['state'],
      tileTypes: { '': 'Outlet' },
    });
    expect(kinds(plans)).toEqual([['Outlet']]);
  });
});

describe('sensors', () => {
  const sensors = [
    property({ key: 'temperature', semantic: 'temperature', type: 'numeric', access: { readable: true, writable: false } }),
    property({ key: 'humidity', semantic: 'humidity', type: 'numeric', access: { readable: true, writable: false } }),
    property({ key: 'battery', semantic: 'battery', type: 'numeric', access: { readable: true, writable: false } }),
  ];

  it('gives each reading its own service', () => {
    const plans = planAccessories(device(sensors), {
      properties: ['temperature', 'humidity', 'battery'],
    });
    expect(kinds(plans)).toEqual([['TemperatureSensor', 'HumiditySensor', 'Battery']]);
  });

  it('links battery rather than leaving it as its own tile', () => {
    const plans = planAccessories(device(sensors), { properties: ['temperature', 'battery'] });
    const battery = plans[0]?.services.find((service) => service.kind === 'Battery');
    expect(battery?.link).toBe(true);
    expect(battery?.bindings.map((binding) => binding.characteristic)).toEqual([
      'BatteryLevel',
      'StatusLowBattery',
    ]);
  });
});

describe('thermostat', () => {
  const climate = [
    property({ key: 'system_mode', semantic: 'system_mode', type: 'enum', values: ['off', 'heat', 'cool', 'auto'] }),
    property({ key: 'occupied_heating_setpoint', semantic: 'occupied_heating_setpoint', type: 'numeric', min: 5, max: 30, step: 0.5 }),
    property({ key: 'local_temperature', semantic: 'local_temperature', type: 'numeric', access: { readable: true, writable: false } }),
  ];

  it('builds one thermostat from the three controls', () => {
    const plans = planAccessories(device(climate), {
      properties: ['system_mode', 'occupied_heating_setpoint', 'local_temperature'],
    });
    expect(kinds(plans)).toEqual([['Thermostat']]);
    expect(plans[0]?.services[0]?.bindings.map((binding) => binding.characteristic)).toEqual([
      'TargetHeatingCoolingState',
      'CurrentHeatingCoolingState',
      'TargetTemperature',
      'CurrentTemperature',
    ]);
  });

  it('narrows the setpoint to the range the device accepts', () => {
    const plans = planAccessories(device(climate), {
      properties: ['system_mode', 'occupied_heating_setpoint'],
    });
    const target = plans[0]?.services[0]?.bindings.find(
      (binding) => binding.characteristic === 'TargetTemperature',
    );
    // HomeKit would otherwise default to 10 to 38 and refuse this thermostat.
    expect(target?.props).toEqual({ minValue: 5, maxValue: 30, minStep: 0.5 });
  });

  it('offers only the modes the device declares', () => {
    const heatOnly = [
      property({ key: 'system_mode', semantic: 'system_mode', type: 'enum', values: ['off', 'heat'] }),
    ];
    const plans = planAccessories(device(heatOnly), { properties: ['system_mode'] });
    expect(plans[0]?.services[0]?.bindings[0]?.props?.validValues).toEqual([0, 1]);
  });

  it('needs the mode, since without it there is nothing to control', () => {
    const plans = planAccessories(device(climate), {
      properties: ['occupied_heating_setpoint', 'local_temperature'],
    });
    expect(plans).toEqual([]);
  });
});

describe('buttons', () => {
  const rocker = property({
    key: 'action',
    semantic: 'action',
    type: 'enum',
    access: { readable: true, writable: false },
    category: 'diagnostic',
    values: [
      'single_left', 'single_right', 'single_both',
      'double_left', 'double_right', 'double_both',
      'triple_left', 'triple_right', 'triple_both',
      'hold_left', 'hold_right', 'hold_both',
    ],
  });

  it('makes one button service per physical button', () => {
    const plans = planAccessories(device([rocker]), { properties: ['action'] });
    expect(kinds(plans)).toEqual([
      ['StatelessProgrammableSwitch', 'StatelessProgrammableSwitch', 'StatelessProgrammableSwitch'],
    ]);
    expect(plans[0]?.services.map((service) => service.name)).toEqual([
      'Living room left',
      'Living room right',
      'Living room both',
    ]);
  });

  it('numbers the buttons so the Home app can tell them apart', () => {
    const plans = planAccessories(device([rocker]), { properties: ['action'] });
    expect(plans[0]?.services.map((service) => service.constants?.[0]?.value)).toEqual([1, 2, 3]);
  });

  it('maps the gestures HomeKit has and drops the ones it does not', () => {
    const plans = planAccessories(device([rocker]), { properties: ['action'] });
    expect(plans[0]?.services[0]?.events).toEqual({
      single_left: 0,
      double_left: 1,
      hold_left: 2,
    });
    // triple_left has no HomeKit equivalent, so it stays for the rules engine.
    expect(plans[0]?.services[0]?.events).not.toHaveProperty('triple_left');
  });


  it('publishes only the gestures that were kept', () => {
    const plans = planAccessories(device([rocker]), {
      properties: ['action'],
      buttons: { action: { left: [2], right: [1] } },
    });
    const [left, right, both] = plans[0]!.services;
    expect(left?.events).toEqual({ hold_left: 2 });
    expect(right?.events).toEqual({ double_right: 1 });
    // `both` has no entry, so it keeps everything.
    expect(both?.events).toEqual({ single_both: 0, double_both: 1, hold_both: 2 });
  });

  it('tells HomeKit which gestures a button offers', () => {
    const plans = planAccessories(device([rocker]), {
      properties: ['action'],
      buttons: { action: { left: [2] } },
    });
    // Without this the Home app would offer all three and two would never fire.
    expect(plans[0]!.services[0]?.bindings[0]?.props?.validValues).toEqual([2]);
  });

  it('drops a button switched off entirely', () => {
    const plans = planAccessories(device([rocker]), {
      properties: ['action'],
      buttons: { action: { left: [], right: [] } },
    });
    expect(plans[0]!.services.map((service) => service.subtype)).toEqual(['action:both']);
  });

  it('keeps button numbering stable when one is switched off', () => {
    const all = planAccessories(device([rocker]), { properties: ['action'] });
    const withoutLeft = planAccessories(device([rocker]), {
      properties: ['action'],
      buttons: { action: { left: [] } },
    });

    const indexOf = (plans: AccessoryPlan[], subtype: string) =>
      plans[0]!.services.find((service) => service.subtype === subtype)?.constants?.[0]?.value;

    // Renumbering would silently repoint automations at the wrong button.
    expect(indexOf(all, 'action:both')).toBe(3);
    expect(indexOf(withoutLeft, 'action:both')).toBe(3);
  });

  it('skips a button whose every gesture is one HomeKit cannot express', () => {
    const tripleOnly = property({
      key: 'action',
      semantic: 'action',
      type: 'enum',
      access: { readable: true, writable: false },
      values: ['triple_left', 'release_left'],
    });
    expect(planAccessories(device([tripleOnly]), { properties: ['action'] })).toEqual([]);
  });
});

describe('the W100, which is all of it at once', () => {
  const w100 = [
    property({ key: 'system_mode', semantic: 'system_mode', type: 'enum', values: ['off', 'heat', 'cool', 'auto'] }),
    property({ key: 'occupied_heating_setpoint', semantic: 'occupied_heating_setpoint', type: 'numeric', min: 5, max: 30, step: 0.5 }),
    property({ key: 'local_temperature', semantic: 'local_temperature', type: 'numeric', access: { readable: true, writable: false } }),
    property({ key: 'temperature', semantic: 'temperature', type: 'numeric', access: { readable: true, writable: false } }),
    property({ key: 'humidity', semantic: 'humidity', type: 'numeric', access: { readable: true, writable: false } }),
    property({ key: 'battery', semantic: 'battery', type: 'numeric', access: { readable: true, writable: false } }),
    property({
      key: 'action',
      semantic: 'action',
      type: 'enum',
      access: { readable: true, writable: false },
      values: ['single_plus', 'double_plus', 'hold_plus', 'single_center', 'single_minus'],
    }),
  ];

  it('produces one accessory carrying every kind of service', () => {
    const plans = planAccessories(device(w100, { name: 'Thermostaat woonkamer' }), {
      properties: w100.map((property) => property.key),
    });
    expect(plans).toHaveLength(1);
    expect(kinds(plans)[0]).toEqual([
      'Thermostat',
      'TemperatureSensor',
      'HumiditySensor',
      'Battery',
      'StatelessProgrammableSwitch',
      'StatelessProgrammableSwitch',
      'StatelessProgrammableSwitch',
    ]);
  });

  it('keeps every service subtype distinct, since HomeKit needs that', () => {
    const plans = planAccessories(device(w100), {
      properties: w100.map((property) => property.key),
    });
    const subtypes = plans[0]!.services.map((service) => service.subtype);
    expect(new Set(subtypes).size).toBe(subtypes.length);
  });
});
