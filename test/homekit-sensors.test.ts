import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Characteristic, Service } from 'hap-nodejs';
import { describe, expect, it } from 'vitest';

import { Catalog } from '../src/catalog.js';
import { planAccessories, roleFor } from '../src/homekit/mapping.js';
import { AccessoryManager } from '../src/homekit/manager.js';
import { toHomeKit } from '../src/homekit/values.js';
import { silentLogger } from '../src/logger.js';
import type { NormalisedProperty } from '../src/model/types.js';
import { Store } from '../src/store.js';
import { sanitiseExposure } from '../src/web/server.js';
import fixture from './fixtures/bridge-devices.json' with { type: 'json' };
import safety from './fixtures/safety-devices.json' with { type: 'json' };
import { fakeApi } from './helpers/fake-homebridge.js';
import { FakeMqtt } from './helpers/fake-mqtt.js';

const SMOKE = { id: '0x00158dfffe0000a1', topic: 'zigbee2mqtt/hallway_smoke-develco' };
const DOOR = { id: '0x00158dfffe0000a2', topic: 'zigbee2mqtt/front_door-contact' };
const MOTION = { id: '0x00158dfffe0000a3', topic: 'zigbee2mqtt/hallway_motion-aqara' };
const PRESENCE = { id: '0x00158dfffe0000a4', topic: 'zigbee2mqtt/study_presence-aqara' };

const flag = (key: string, over: Partial<NormalisedProperty> = {}): NormalisedProperty => ({
  key,
  label: key,
  semantic: key,
  type: 'binary',
  access: { readable: true, writable: false },
  category: 'primary',
  onValue: true,
  offValue: false,
  stateTopic: 'zigbee2mqtt/device',
  extract: [key],
  ...over,
});

describe('what each reading is to HomeKit', () => {
  it('knows the safety sensors by the names Zigbee2MQTT gives them', () => {
    expect(roleFor(flag('contact'))).toBe('contact');
    expect(roleFor(flag('smoke'))).toBe('smoke');
    // A PIR reports motion; an mmWave sensor reports somebody being there.
    expect(roleFor(flag('occupancy'))).toBe('motion');
    expect(roleFor(flag('presence'))).toBe('occupancy');
    expect(roleFor(flag('battery_low'))).toBe('lowBattery');
    expect(roleFor(flag('low_battery'))).toBe('lowBattery');
    expect(roleFor(flag('tamper'))).toBe('tamper');
  });

  it('leaves out a reading that cannot be read back', () => {
    expect(roleFor(flag('smoke', { access: { readable: false, writable: false } }))).toBeUndefined();
  });

  it('says a shut door is contact detected, which is what HomeKit calls closed', () => {
    // Zigbee2MQTT's contact is true while the two halves touch, and it is
    // declared the other way up from every other binary: on is open.
    const contact = flag('contact', { onValue: false, offValue: true });
    expect(toHomeKit('ContactSensorState', contact, true)).toBe(0);
    expect(toHomeKit('ContactSensorState', contact, false)).toBe(1);
    // However the property happens to be declared, the wire value decides.
    expect(toHomeKit('ContactSensorState', flag('contact'), true)).toBe(0);
    expect(toHomeKit('ContactSensorState', flag('contact'), false)).toBe(1);
  });

  it('turns the rest into the numbers and truths HomeKit wants', () => {
    expect(toHomeKit('SmokeDetected', flag('smoke'), true)).toBe(1);
    expect(toHomeKit('SmokeDetected', flag('smoke'), false)).toBe(0);
    expect(toHomeKit('MotionDetected', flag('occupancy'), true)).toBe(true);
    expect(toHomeKit('OccupancyDetected', flag('presence'), true)).toBe(1);
    expect(toHomeKit('StatusTampered', flag('tamper'), true)).toBe(1);
    expect(toHomeKit('StatusLowBattery', flag('battery_low'), true)).toBe(1);
    expect(toHomeKit('StatusLowBattery', flag('battery_low'), false)).toBe(0);
    // Nothing heard yet is not a reading.
    expect(toHomeKit('SmokeDetected', flag('smoke'), undefined)).toBeUndefined();
  });
});

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'mq77-sensors-'));
  const store = new Store(join(directory, 'state.json'), silentLogger);
  await store.load();

  const mqtt = new FakeMqtt();
  const catalog = new Catalog(mqtt.asConnection(), silentLogger);
  await catalog.start([{ id: 'zigbee', adapter: 'zigbee2mqtt', baseTopic: 'zigbee2mqtt' }]);
  mqtt.deliver('zigbee2mqtt/bridge/devices', [...fixture, ...safety], { retained: true });

  const hb = fakeApi();
  const manager = new AccessoryManager(hb.api, silentLogger, catalog, store, mqtt.asConnection());
  catalog.on('state', (update) => manager.handleState(update));

  const publish = (deviceId: string, properties: string[]) => {
    store.setExposure(`zigbee:${deviceId}`, { properties });
    manager.sync();
    return hb.registered.find((accessory) =>
      accessory.getService(Service.AccessoryInformation)?.getCharacteristic(Characteristic.SerialNumber)
        .value === deviceId,
    )!;
  };
  return { mqtt, catalog, publish };
}

describe('a smoke alarm', () => {
  it('is a smoke sensor first, with its reading beside it and its battery linked', async () => {
    const { catalog } = await harness();
    const device = catalog.getDevice('zigbee', SMOKE.id)!;
    const plans = planAccessories(device, {
      properties: ['smoke', 'temperature', 'battery', 'battery_low'],
    });

    expect(plans[0]?.services.map((service) => service.kind)).toEqual([
      'SmokeSensor',
      'TemperatureSensor',
      'Battery',
    ]);
    // A percentage says what the flag says and more, so it is the one used.
    const battery = plans[0]?.services.find((service) => service.kind === 'Battery');
    expect(battery?.bindings.map((binding) => binding.characteristic)).toEqual([
      'BatteryLevel',
      'StatusLowBattery',
    ]);
  });

  it('goes off in HomeKit when the device says smoke', async () => {
    const { mqtt, publish } = await harness();
    const accessory = publish(SMOKE.id, ['smoke', 'temperature', 'battery']);

    mqtt.deliver(SMOKE.topic, { smoke: true, temperature: 23.87, battery: 100 });

    const smoke = accessory.getService(Service.SmokeSensor)!;
    expect(smoke.getCharacteristic(Characteristic.SmokeDetected).value).toBe(1);
    // The Home app reads the first service that is not linked as what the
    // accessory is.
    expect(smoke.isPrimaryService).toBe(true);
    // HomeKit keeps a temperature to a tenth of a degree.
    expect(
      accessory.getService(Service.TemperatureSensor)?.getCharacteristic(
        Characteristic.CurrentTemperature,
      ).value,
    ).toBeCloseTo(23.9, 5);
  });
});

describe('a door sensor', () => {
  it('is a contact sensor saying closed and open the way HomeKit means them', async () => {
    const { mqtt, publish } = await harness();
    const accessory = publish(DOOR.id, ['contact']);
    const contact = accessory.getService(Service.ContactSensor)!;

    mqtt.deliver(DOOR.topic, { contact: true });
    expect(contact.getCharacteristic(Characteristic.ContactSensorState).value).toBe(
      Characteristic.ContactSensorState.CONTACT_DETECTED,
    );

    mqtt.deliver(DOOR.topic, { contact: false });
    expect(contact.getCharacteristic(Characteristic.ContactSensorState).value).toBe(
      Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
    );
  });

  it('says it has been tampered with on the sensor itself', async () => {
    const { mqtt, publish } = await harness();
    const accessory = publish(DOOR.id, ['contact', 'tamper']);

    mqtt.deliver(DOOR.topic, { contact: true, tamper: true });

    const contact = accessory.getService(Service.ContactSensor)!;
    expect(contact.getCharacteristic(Characteristic.StatusTampered).value).toBe(
      Characteristic.StatusTampered.TAMPERED,
    );
  });

  it('shows a flat battery from a device that only raises a flag', async () => {
    const { mqtt, publish } = await harness();
    const accessory = publish(DOOR.id, ['contact', 'battery_low']);

    mqtt.deliver(DOOR.topic, { contact: true, battery_low: true });

    const battery = accessory.getService(Service.Battery)!;
    expect(battery.getCharacteristic(Characteristic.StatusLowBattery).value).toBe(
      Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW,
    );
  });
});

describe('motion and presence', () => {
  it('makes a PIR a motion sensor', async () => {
    const { mqtt, publish } = await harness();
    const accessory = publish(MOTION.id, ['occupancy']);
    mqtt.deliver(MOTION.topic, { occupancy: true });

    expect(accessory.getService(Service.MotionSensor)?.getCharacteristic(
      Characteristic.MotionDetected,
    ).value).toBe(true);
  });

  it('makes `occupancy` an occupancy sensor when that was chosen for the device', async () => {
    // An mmWave sensor like the Sonoff SNZB-06P says `occupancy` too, and only
    // somebody who knows the device can say which it is.
    const { mqtt, catalog } = await harness();
    const device = catalog.getDevice('zigbee', MOTION.id)!;

    expect(
      planAccessories(device, { properties: ['occupancy'] })[0]?.services.map((s) => s.kind),
    ).toEqual(['MotionSensor']);
    expect(
      planAccessories(device, {
        properties: ['occupancy'],
        sensorTypes: { occupancy: 'Occupancy' },
      })[0]?.services.map((s) => s.kind),
    ).toEqual(['OccupancySensor']);
    mqtt.deliver(MOTION.topic, { occupancy: true });
  });

  it('keeps only a choice away from the default, for a reading the device has', () => {
    const saved = sanitiseExposure(
      {
        properties: [],
        sensorTypes: { occupancy: 'Occupancy', other: 'Occupancy', motionish: 'Motion', odd: 'Siren' },
      },
      ['occupancy', 'motionish', 'odd'],
    );
    expect(saved.sensorTypes).toEqual({ occupancy: 'Occupancy' });
    expect(sanitiseExposure({ properties: [], sensorTypes: { occupancy: 'Motion' } }, ['occupancy']))
      .not.toHaveProperty('sensorTypes');
  });

  it('makes an mmWave sensor an occupancy sensor', async () => {
    const { mqtt, publish } = await harness();
    const accessory = publish(PRESENCE.id, ['presence']);
    mqtt.deliver(PRESENCE.topic, { presence: true });

    expect(accessory.getService(Service.OccupancySensor)?.getCharacteristic(
      Characteristic.OccupancyDetected,
    ).value).toBe(Characteristic.OccupancyDetected.OCCUPANCY_DETECTED);
  });
});

describe('what reaches HomeKit', () => {
  it('only what is ticked, as with everything else', async () => {
    const { catalog } = await harness();
    const device = catalog.getDevice('zigbee', SMOKE.id)!;
    expect(planAccessories(device, { properties: ['temperature'] })[0]?.services.map((s) => s.kind))
      .toEqual(['TemperatureSensor']);
  });
});
