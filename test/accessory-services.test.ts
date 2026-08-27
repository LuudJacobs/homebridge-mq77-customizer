import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Characteristic, Service } from 'hap-nodejs';
import { beforeEach, describe, expect, it } from 'vitest';

import { Catalog } from '../src/catalog.js';
import { AccessoryManager } from '../src/homekit/manager.js';
import { silentLogger } from '../src/logger.js';
import { Store } from '../src/store.js';
import fixture from './fixtures/bridge-devices.json' with { type: 'json' };
import { fakeApi, type FakeApi } from './helpers/fake-homebridge.js';
import { FakeMqtt } from './helpers/fake-mqtt.js';

const W100 = { id: '0x00158dfffe000004', topic: 'zigbee2mqtt/living_room_climate-w100' };
const DIMMER = { id: '0x00158dfffe000003', topic: 'zigbee2mqtt/kitchen_dimmer-candeo' };
const ROCKER = { id: '0x00158dfffe000005', topic: 'zigbee2mqtt/bedroom_rocker-wrs02' };
const SOCKET = { id: '0x00158dfffe000006', topic: 'zigbee2mqtt/living_room_lamp-socket' };

interface Harness {
  manager: AccessoryManager;
  store: Store;
  mqtt: FakeMqtt;
  catalog: Catalog;
  hb: FakeApi;
}

async function harness(): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'mq77-customizer-svc-'));
  const store = new Store(join(directory, 'state.json'), silentLogger);
  await store.load();

  const mqtt = new FakeMqtt();
  const catalog = new Catalog(mqtt.asConnection(), silentLogger);
  await catalog.start([{ id: 'zigbee', adapter: 'zigbee2mqtt', baseTopic: 'zigbee2mqtt' }]);
  mqtt.deliver('zigbee2mqtt/bridge/devices', fixture, { retained: true });

  const hb = fakeApi();
  const manager = new AccessoryManager(hb.api, silentLogger, catalog, store, mqtt.asConnection());
  catalog.on('state', (update) => manager.handleState(update));
  return { manager, store, mqtt, catalog, hb };
}

/** Every property of a device, as the interface would offer them. */
function allProperties(context: Harness, deviceId: string): string[] {
  return (
    context.catalog
      .getDevice('zigbee', deviceId)
      ?.properties.map((property) => property.key) ?? []
  );
}

describe('dimmable light', () => {
  let context: Harness;

  beforeEach(async () => {
    context = await harness();
    context.mqtt.deliver(DIMMER.topic, { state: 'ON', brightness: 127 });
    context.store.setExposure(`zigbee:${DIMMER.id}`, {
      properties: ['state', 'brightness'],
      tileTypes: { '': 'Switch' },
    });
    context.manager.sync();
  });

  it('publishes a lightbulb even though a switch was picked', () => {
    const accessory = context.hb.registered[0]!;
    expect(accessory.getServiceById(Service.Lightbulb, 'state')).toBeDefined();
    expect(accessory.getServiceById(Service.Switch, 'state')).toBeUndefined();
  });

  it('reports brightness as a percentage of the device range', () => {
    const light = context.hb.registered[0]!.getServiceById(Service.Lightbulb, 'state')!;
    expect(light.getCharacteristic(Characteristic.Brightness).value).toBe(50);
  });

  it('scales a percentage back to the device range when set', async () => {
    const light = context.hb.registered[0]!.getServiceById(Service.Lightbulb, 'state')!;
    await light.getCharacteristic(Characteristic.Brightness).handleSetRequest(100);

    expect(context.mqtt.published).toEqual([
      { topic: `${DIMMER.topic}/set`, payload: '{"brightness":254}', retain: false },
    ]);
  });

  it('follows the device when it is dimmed elsewhere', () => {
    const light = context.hb.registered[0]!.getServiceById(Service.Lightbulb, 'state')!;
    context.mqtt.deliver(DIMMER.topic, { brightness: 254 });
    expect(light.getCharacteristic(Characteristic.Brightness).value).toBe(100);
  });
});

describe('socket with a child lock', () => {
  async function socketWithLock(tile: 'Outlet' | 'Fan' = 'Outlet') {
    const context = await harness();
    context.mqtt.deliver(SOCKET.topic, { state: 'ON', child_lock: 'LOCK' });
    context.store.setExposure(`zigbee:${SOCKET.id}`, {
      properties: ['state', 'child_lock'],
      tileTypes: { '': tile },
    });
    context.manager.sync();
    return context;
  }

  it('gives the lock a switch of its own, since an outlet cannot show one', async () => {
    const context = await socketWithLock();
    const accessory = context.hb.registered[0]!;

    // HomeKit allows a physical lock on the air services only. An outlet
    // accepts the characteristic and shows nothing, which is what happened:
    // the box was ticked and the Home app carried on as before.
    const outlet = accessory.getServiceById(Service.Outlet, 'state')!;
    expect(outlet.testCharacteristic(Characteristic.LockPhysicalControls)).toBe(false);

    const lock = accessory.getServiceById(Service.Switch, 'child_lock')!;
    expect(lock).toBeDefined();
    expect(lock.getCharacteristic(Characteristic.On).value).toBe(true);
  });

  it('names the lock after the device it belongs to', async () => {
    const context = await socketWithLock();
    const lock = context.hb.registered[0]!.getServiceById(Service.Switch, 'child_lock')!;
    expect(lock.displayName).toContain('Child lock');
  });

  it('sends the lock the words the device uses', async () => {
    const context = await socketWithLock();
    const lock = context.hb.registered[0]!.getServiceById(Service.Switch, 'child_lock')!;

    lock.getCharacteristic(Characteristic.On).setValue(false);
    expect(context.mqtt.published.at(-1)).toMatchObject({
      topic: `${SOCKET.topic}/set`,
      payload: '{"child_lock":"UNLOCK"}',
    });
  });

  it('keeps it on the tile where HomeKit does allow it', async () => {
    const context = await socketWithLock('Fan');
    const fan = context.hb.registered[0]!.getServiceById(Service.Fan, 'state')!;

    // A fan is an air service, so the lock belongs on it rather than beside it.
    expect(fan.getCharacteristic(Characteristic.LockPhysicalControls).value).toBe(1);
    expect(context.hb.registered[0]!.getServiceById(Service.Switch, 'child_lock')).toBeUndefined();
  });
});

describe('climate sensor', () => {
  let context: Harness;

  beforeEach(async () => {
    context = await harness();
    context.mqtt.deliver(W100.topic, {
      system_mode: 'heat',
      occupied_heating_setpoint: 21,
      local_temperature: 19.5,
      temperature: 19.8,
      humidity: 47,
      battery: 76,
    });
    context.store.setExposure(`zigbee:${W100.id}`, {
      properties: allProperties(context, W100.id),
    });
    context.manager.sync();
  });

  it('produces one accessory carrying every service', () => {
    expect(context.hb.registered).toHaveLength(1);
    const accessory = context.hb.registered[0]!;
    expect(accessory.getServiceById(Service.Thermostat, 'system_mode')).toBeDefined();
    expect(accessory.getServiceById(Service.TemperatureSensor, 'temperature')).toBeDefined();
    expect(accessory.getServiceById(Service.HumiditySensor, 'humidity')).toBeDefined();
    expect(accessory.getServiceById(Service.Battery, 'battery')).toBeDefined();
  });

  it('reads the thermostat', () => {
    const thermostat = context.hb.registered[0]!.getServiceById(Service.Thermostat, 'system_mode')!;
    expect(thermostat.getCharacteristic(Characteristic.TargetHeatingCoolingState).value).toBe(1);
    expect(thermostat.getCharacteristic(Characteristic.CurrentHeatingCoolingState).value).toBe(1);
    expect(thermostat.getCharacteristic(Characteristic.TargetTemperature).value).toBe(21);
    expect(thermostat.getCharacteristic(Characteristic.CurrentTemperature).value).toBe(19.5);
  });

  it('accepts a setpoint below what HomeKit allows by default', async () => {
    const thermostat = context.hb.registered[0]!.getServiceById(Service.Thermostat, 'system_mode')!;
    const target = thermostat.getCharacteristic(Characteristic.TargetTemperature);
    // HomeKit defaults to a 10 degree floor, this device goes to 5.
    expect(target.props.minValue).toBe(5);
    expect(target.props.maxValue).toBe(30);

    await target.handleSetRequest(5);
    expect(context.mqtt.published).toEqual([
      { topic: `${W100.topic}/set`, payload: '{"occupied_heating_setpoint":5}', retain: false },
    ]);
  });

  it('sends a mode change as the name the device uses', async () => {
    const thermostat = context.hb.registered[0]!.getServiceById(Service.Thermostat, 'system_mode')!;
    await thermostat.getCharacteristic(Characteristic.TargetHeatingCoolingState).handleSetRequest(0);
    expect(context.mqtt.published).toEqual([
      { topic: `${W100.topic}/set`, payload: '{"system_mode":"off"}', retain: false },
    ]);
  });

  it('infers what the thermostat is doing on auto', () => {
    const thermostat = context.hb.registered[0]!.getServiceById(Service.Thermostat, 'system_mode')!;
    context.mqtt.deliver(W100.topic, { system_mode: 'auto' });
    // Room is below its setpoint, so it must be heating.
    expect(thermostat.getCharacteristic(Characteristic.CurrentHeatingCoolingState).value).toBe(1);

    context.mqtt.deliver(W100.topic, { local_temperature: 23 });
    expect(thermostat.getCharacteristic(Characteristic.CurrentHeatingCoolingState).value).toBe(0);
  });

  it('reports the sensors', () => {
    const accessory = context.hb.registered[0]!;
    expect(
      accessory
        .getServiceById(Service.TemperatureSensor, 'temperature')!
        .getCharacteristic(Characteristic.CurrentTemperature).value,
      // HAP rounds to the characteristic's step, so this lands a hair off.
    ).toBeCloseTo(19.8, 5);
    expect(
      accessory
        .getServiceById(Service.HumiditySensor, 'humidity')!
        .getCharacteristic(Characteristic.CurrentRelativeHumidity).value,
    ).toBe(47);
  });

  it('shows the battery and warns when it gets low', () => {
    const battery = context.hb.registered[0]!.getServiceById(Service.Battery, 'battery')!;
    expect(battery.getCharacteristic(Characteristic.BatteryLevel).value).toBe(76);
    expect(battery.getCharacteristic(Characteristic.StatusLowBattery).value).toBe(0);

    context.mqtt.deliver(W100.topic, { battery: 9 });
    expect(battery.getCharacteristic(Characteristic.StatusLowBattery).value).toBe(1);
  });

  it('links the battery so it shows on the accessory itself', () => {
    const accessory = context.hb.registered[0]!;
    const thermostat = accessory.getServiceById(Service.Thermostat, 'system_mode')!;
    const battery = accessory.getServiceById(Service.Battery, 'battery')!;
    expect(thermostat.linkedServices).toContain(battery);
  });
});

describe('buttons', () => {
  let context: Harness;

  beforeEach(async () => {
    context = await harness();
    context.store.setExposure(`zigbee:${W100.id}`, { properties: ['action'] });
    context.manager.sync();
  });

  it('makes a button service per physical button', () => {
    const accessory = context.hb.registered[0]!;
    const buttons = accessory.services.filter(
      (service) => service.UUID === Service.StatelessProgrammableSwitch.UUID,
    );
    expect(buttons.map((service) => service.subtype)).toEqual([
      'action:W100_PMTSD_request',
      'action:plus',
      'action:center',
      'action:minus',
    ]);
  });

  /**
   * A press is an event, not a state, and the characteristic's value starts at
   * zero rather than empty. Watching for notifications is the only way to tell
   * a single press from nothing having happened.
   */
  function pressesOn(subtype: string): number[] {
    const seen: number[] = [];
    context.hb
      .registered[0]!.getServiceById(Service.StatelessProgrammableSwitch, subtype)!
      .getCharacteristic(Characteristic.ProgrammableSwitchEvent)
      .on('change', (change) => seen.push(change.newValue as number));
    return seen;
  }

  it('fires the matching event when the button is pressed', () => {
    const presses = pressesOn('action:plus');

    context.mqtt.deliver(W100.topic, { action: 'single_plus' });
    context.mqtt.deliver(W100.topic, { action: 'double_plus' });
    context.mqtt.deliver(W100.topic, { action: 'hold_plus' });

    expect(presses).toEqual([0, 1, 2]);
  });

  it('fires again when the same gesture repeats', () => {
    const presses = pressesOn('action:plus');

    context.mqtt.deliver(W100.topic, { action: 'single_plus' });
    context.mqtt.deliver(W100.topic, { action: 'single_plus' });

    // Pressing a button twice has to notify twice, even though the value did
    // not change.
    expect(presses).toEqual([0, 0]);
  });

  it('does not fire another button', () => {
    const presses = pressesOn('action:minus');
    context.mqtt.deliver(W100.topic, { action: 'single_plus' });
    expect(presses).toEqual([]);
  });

  it('ignores a gesture HomeKit cannot express', () => {
    const presses = pressesOn('action:plus');
    context.mqtt.deliver(W100.topic, { action: 'release_plus' });
    expect(presses).toEqual([]);
  });

  it('does not fire on a retained press replayed after a reconnect', () => {
    const presses = pressesOn('action:plus');
    // Otherwise every reconnect would set off whatever automation the last
    // press was wired to.
    context.mqtt.deliver(W100.topic, { action: 'single_plus' }, { retained: true });
    expect(presses).toEqual([]);
  });
});

describe('a device that has not reported yet', () => {
  it('still serves its battery instead of failing the read', async () => {
    const context = await harness();
    // Nothing delivered on the device topic. Zigbee2MQTT does not retain state,
    // so this is what a battery remote looks like until someone presses it.
    context.store.setExposure(`zigbee:${ROCKER.id}`, { properties: ['battery', 'action'] });
    context.manager.sync();

    const battery = context.hb.registered[0]!.getServiceById(Service.Battery, 'battery')!;
    await expect(
      battery.getCharacteristic(Characteristic.BatteryLevel).handleGetRequest(),
    ).resolves.toBeDefined();
  });

  it('corrects itself as soon as the device does report', async () => {
    const context = await harness();
    context.store.setExposure(`zigbee:${ROCKER.id}`, { properties: ['battery'] });
    context.manager.sync();

    context.mqtt.deliver(ROCKER.topic, { battery: 88 });

    const battery = context.hb.registered[0]!.getServiceById(Service.Battery, 'battery')!;
    expect(battery.getCharacteristic(Characteristic.BatteryLevel).value).toBe(88);
  });

  it('marks a primary service, which controllers want before showing a linked battery', async () => {
    const context = await harness();
    context.store.setExposure(`zigbee:${ROCKER.id}`, { properties: ['battery', 'action'] });
    context.manager.sync();

    const accessory = context.hb.registered[0]!;
    const battery = accessory.getServiceById(Service.Battery, 'battery')!;
    const primary = accessory.services.find((service) => service.isPrimaryService);
    expect(primary).toBeDefined();
    expect(primary!.linkedServices).toContain(battery);
  });
});

describe('changing which gestures a button offers', () => {
  const selection = (gestures: number[]) => ({
    properties: ['action'],
    buttons: { action: { plus: gestures, center: gestures, minus: gestures } },
  });

  it('tells HomeKit about the new gesture list', async () => {
    const context = await harness();
    context.store.setExposure(`zigbee:${W100.id}`, { properties: ['action'] });
    context.manager.sync();

    const before = context.hb
      .registered[0]!.getServiceById(Service.StatelessProgrammableSwitch, 'action:plus')!
      .getCharacteristic(Characteristic.ProgrammableSwitchEvent);
    expect(before.props.validValues).toEqual([0, 1, 2]);

    context.store.setExposure(`zigbee:${W100.id}`, selection([2]));
    context.manager.sync();

    // setProps alone raises no configuration change, so the service has to be
    // rebuilt or the Home app keeps offering all three.
    const after = context.hb
      .registered[0]!.getServiceById(Service.StatelessProgrammableSwitch, 'action:plus')!
      .getCharacteristic(Characteristic.ProgrammableSwitchEvent);
    expect(after.props.validValues).toEqual([2]);
    expect(after).not.toBe(before);
  });

  it('leaves services alone when nothing changed', async () => {
    const context = await harness();
    context.store.setExposure(`zigbee:${W100.id}`, selection([2]));
    context.manager.sync();

    const first = context.hb
      .registered[0]!.getServiceById(Service.StatelessProgrammableSwitch, 'action:plus')!
      .getCharacteristic(Characteristic.ProgrammableSwitchEvent);

    context.manager.sync();
    context.manager.sync();

    // Rebuilding on every sync would bump the bridge configuration on each
    // restart and churn the Home app for no reason.
    const again = context.hb
      .registered[0]!.getServiceById(Service.StatelessProgrammableSwitch, 'action:plus')!
      .getCharacteristic(Characteristic.ProgrammableSwitchEvent);
    expect(again).toBe(first);
  });

  it('stops firing a dropped gesture straight away, without a restart', async () => {
    const context = await harness();
    context.store.setExposure(`zigbee:${W100.id}`, { properties: ['action'] });
    context.manager.sync();

    const watch = () => {
      const seen: number[] = [];
      context.hb
        .registered[0]!.getServiceById(Service.StatelessProgrammableSwitch, 'action:plus')!
        .getCharacteristic(Characteristic.ProgrammableSwitchEvent)
        .on('change', (change) => seen.push(change.newValue as number));
      return seen;
    };

    const before = watch();
    context.mqtt.deliver(W100.topic, { action: 'hold_plus' });
    expect(before).toEqual([2]);

    // Narrowed to single press only, exactly as the interface saves it.
    context.store.setExposure(`zigbee:${W100.id}`, selection([0]));
    context.manager.sync();

    const after = watch();
    context.mqtt.deliver(W100.topic, { action: 'hold_plus' });
    context.mqtt.deliver(W100.topic, { action: 'single_plus' });

    // Long press is ignored from this moment, whatever the Home app is still
    // showing in its own list of gestures.
    expect(after).toEqual([0]);
  });

  it('still fires only the gesture that was kept', async () => {
    const context = await harness();
    context.store.setExposure(`zigbee:${W100.id}`, selection([2]));
    context.manager.sync();

    const seen: number[] = [];
    context.hb
      .registered[0]!.getServiceById(Service.StatelessProgrammableSwitch, 'action:plus')!
      .getCharacteristic(Characteristic.ProgrammableSwitchEvent)
      .on('change', (change) => seen.push(change.newValue as number));

    context.mqtt.deliver(W100.topic, { action: 'single_plus' });
    context.mqtt.deliver(W100.topic, { action: 'hold_plus' });

    expect(seen).toEqual([2]);
  });
});

describe('not talking to HomeKit for nothing', () => {
  it('says nothing when a device repeats a value it already reported', async () => {
    const context = await harness();
    context.mqtt.deliver(DIMMER.topic, { state: 'ON', brightness: 127 });
    context.store.setExposure(`zigbee:${DIMMER.id}`, { properties: ['state', 'brightness'] });
    context.manager.sync();

    const light = context.hb.registered[0]!.getServiceById(Service.Lightbulb, 'state')!;
    const changes: string[] = [];
    for (const characteristic of [Characteristic.On, Characteristic.Brightness]) {
      light.getCharacteristic(characteristic).on('change', () => changes.push('changed'));
    }

    // Zigbee2MQTT republishes full state constantly, more so with last_seen
    // on. None of this is news to HomeKit.
    for (let repeat = 0; repeat < 20; repeat++) {
      context.mqtt.deliver(DIMMER.topic, { state: 'ON', brightness: 127, linkquality: repeat });
    }
    expect(changes).toEqual([]);
  });

  it('still passes on a value that did move', async () => {
    const context = await harness();
    context.mqtt.deliver(DIMMER.topic, { state: 'ON', brightness: 127 });
    context.store.setExposure(`zigbee:${DIMMER.id}`, { properties: ['state', 'brightness'] });
    context.manager.sync();

    const light = context.hb.registered[0]!.getServiceById(Service.Lightbulb, 'state')!;
    const seen: unknown[] = [];
    light.getCharacteristic(Characteristic.Brightness).on('change', (change) => seen.push(change.newValue));

    context.mqtt.deliver(DIMMER.topic, { brightness: 254 });
    context.mqtt.deliver(DIMMER.topic, { brightness: 254 });
    context.mqtt.deliver(DIMMER.topic, { brightness: 0 });

    expect(seen).toEqual([100, 0]);
  });
});
