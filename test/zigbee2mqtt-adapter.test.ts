import { beforeEach, describe, expect, it } from 'vitest';

import { Zigbee2mqttAdapter } from '../src/adapters/zigbee2mqtt/adapter.js';
import { silentLogger } from '../src/logger.js';
import type { StateUpdate } from '../src/model/types.js';
import fixture from './fixtures/bridge-devices.json' with { type: 'json' };
import { FakeMqtt } from './helpers/fake-mqtt.js';

const BASE = 'zigbee2mqtt';

async function makeAdapter(): Promise<{ adapter: Zigbee2mqttAdapter; mqtt: FakeMqtt }> {
  const mqtt = new FakeMqtt();
  const adapter = new Zigbee2mqttAdapter({
    source: { id: 'zigbee', adapter: 'zigbee2mqtt', baseTopic: BASE },
    mqtt: mqtt.asConnection(),
    log: silentLogger,
  });
  await adapter.start();
  return { adapter, mqtt };
}

describe('Zigbee2mqttAdapter', () => {
  let adapter: Zigbee2mqttAdapter;
  let mqtt: FakeMqtt;

  beforeEach(async () => {
    ({ adapter, mqtt } = await makeAdapter());
  });

  it('subscribes once to the wildcard rather than per device', () => {
    expect(mqtt.filters).toEqual([
      'zigbee2mqtt/bridge/devices',
      'zigbee2mqtt/bridge/state',
      'zigbee2mqtt/bridge/info',
      'zigbee2mqtt/#',
      'zigbee2mqtt/bridge/response/networkmap',
    ]);
  });

  it('builds the catalog from bridge/devices', () => {
    mqtt.deliver(`${BASE}/bridge/devices`, fixture, { retained: true });

    const names = adapter.getDevices().map((device) => device.deviceId);
    expect(names).toEqual([
      '0x00158dfffe000002',
      '0x00158dfffe000003',
      '0x00158dfffe000004',
      '0x00158dfffe000005',
      '0x00158dfffe000006',
    ]);
  });

  it('skips the coordinator, disabled devices and devices with no definition', () => {
    mqtt.deliver(`${BASE}/bridge/devices`, fixture);
    const ids = adapter.getDevices().map((device) => device.deviceId);
    expect(ids).not.toContain('0x00124b0000000001');
    expect(ids).not.toContain('0x0000000000000001');
    expect(ids).not.toContain('0x0000000000000002');
  });

  it('prefers the user description over the friendly name', () => {
    mqtt.deliver(`${BASE}/bridge/devices`, fixture);
    const w100 = adapter.getDevices().find((d) => d.deviceId === '0x00158dfffe000004');
    expect(w100?.name).toBe('Living room thermostat');
    expect(w100?.manufacturer).toBe('Aqara');
    expect(w100?.model).toBe('TH-S04D');
  });

  it('reports the topic a device lives on, which the interface searches', () => {
    mqtt.deliver(`${BASE}/bridge/devices`, fixture);
    const w100 = adapter.getDevices().find((d) => d.deviceId === '0x00158dfffe000004');
    // Its name comes from the description, so the topic is the only place the
    // friendly name survives.
    expect(w100?.name).toBe('Living room thermostat');
    expect(w100?.topic).toBe('zigbee2mqtt/living_room_climate-w100');
  });

  it('records state for known properties', () => {
    mqtt.deliver(`${BASE}/bridge/devices`, fixture);
    mqtt.deliver(`${BASE}/living_room_switch-ZB2GS`, { state_l1: 'ON', state_l2: 'OFF' });

    expect(adapter.getState('0x00158dfffe000002')).toEqual({
      state_l1: 'ON',
      state_l2: 'OFF',
    });
  });

  it('reads values out of composites', () => {
    mqtt.deliver(`${BASE}/bridge/devices`, fixture);
    mqtt.deliver(`${BASE}/kitchen_dimmer-candeo`, {
      state: 'ON',
      brightness: 128,
      level_config: { on_level: 40 },
    });

    expect(adapter.getState('0x00158dfffe000003')).toEqual({
      state: 'ON',
      brightness: 128,
      'level_config.on_level': 40,
    });
  });

  it('ignores properties that are not published by the device', () => {
    mqtt.deliver(`${BASE}/bridge/devices`, fixture);
    // detach_relay_outlet1 is access 2, write only, so it must not be recorded
    // even when something echoes it back.
    mqtt.deliver(`${BASE}/living_room_switch-ZB2GS`, {
      state_l1: 'ON',
      detach_relay_mode: { detach_relay_outlet1: 'ENABLE' },
    });

    expect(adapter.getState('0x00158dfffe000002')).toEqual({ state_l1: 'ON' });
  });

  it('merges partial updates into the known state', () => {
    mqtt.deliver(`${BASE}/bridge/devices`, fixture);
    mqtt.deliver(`${BASE}/living_room_switch-ZB2GS`, { state_l1: 'ON', state_l2: 'ON' });
    mqtt.deliver(`${BASE}/living_room_switch-ZB2GS`, { state_l2: 'OFF' });

    expect(adapter.getState('0x00158dfffe000002')).toEqual({
      state_l1: 'ON',
      state_l2: 'OFF',
    });
  });

  it('flags retained messages so rules can ignore replayed state', () => {
    const updates: StateUpdate[] = [];
    adapter.on('state', (update) => updates.push(update));

    mqtt.deliver(`${BASE}/bridge/devices`, fixture);
    mqtt.deliver(`${BASE}/living_room_switch-ZB2GS`, { state_l1: 'ON' }, { retained: true });
    mqtt.deliver(`${BASE}/living_room_switch-ZB2GS`, { state_l1: 'OFF' });

    expect(updates.map((update) => update.retained)).toEqual([true, false]);
    expect(updates[0]?.changes).toEqual({ state_l1: 'ON' });
  });

  it('ignores command topics, availability and bridge traffic', () => {
    const updates: StateUpdate[] = [];
    mqtt.deliver(`${BASE}/bridge/devices`, fixture);
    adapter.on('state', (update) => updates.push(update));

    mqtt.deliver(`${BASE}/living_room_switch-ZB2GS/set`, { state_l1: 'ON' });
    mqtt.deliver(`${BASE}/living_room_switch-ZB2GS/get`, { state_l1: '' });
    mqtt.deliver(`${BASE}/living_room_switch-ZB2GS/availability`, { state: 'online' });
    mqtt.deliver(`${BASE}/bridge/logging`, { level: 'info', message: 'hello' });

    expect(updates).toHaveLength(0);
  });

  it('emits nothing for an unknown topic', () => {
    const updates: StateUpdate[] = [];
    mqtt.deliver(`${BASE}/bridge/devices`, fixture);
    adapter.on('state', (update) => updates.push(update));

    mqtt.deliver(`${BASE}/some_device_we_do_not_know`, { state: 'ON' });
    expect(updates).toHaveLength(0);
  });

  it('survives malformed payloads', () => {
    mqtt.deliver(`${BASE}/bridge/devices`, 'not json');
    expect(adapter.getDevices()).toEqual([]);

    mqtt.deliver(`${BASE}/bridge/devices`, fixture);
    mqtt.deliver(`${BASE}/living_room_switch-ZB2GS`, 'not json');
    expect(adapter.getState('0x00158dfffe000002')).toBeUndefined();
  });

  it('rebuilds topics when a device is renamed', () => {
    mqtt.deliver(`${BASE}/bridge/devices`, fixture);
    const renamed = JSON.parse(JSON.stringify(fixture)) as { friendly_name: string }[];
    const entry = renamed.find((d) => d.friendly_name === 'living_room_switch-ZB2GS');
    entry!.friendly_name = 'woonkamer_lampen';
    mqtt.deliver(`${BASE}/bridge/devices`, renamed);

    mqtt.deliver(`${BASE}/woonkamer_lampen`, { state_l1: 'ON' });
    expect(adapter.getState('0x00158dfffe000002')).toEqual({ state_l1: 'ON' });

    const device = adapter.getDevices().find((d) => d.deviceId === '0x00158dfffe000002');
    expect(device?.properties[0]?.stateTopic).toBe('zigbee2mqtt/woonkamer_lampen');
    expect(device?.properties[0]?.setTopic).toBe('zigbee2mqtt/woonkamer_lampen/set');
  });

  it('forgets state for devices that leave the network', () => {
    mqtt.deliver(`${BASE}/bridge/devices`, fixture);
    mqtt.deliver(`${BASE}/living_room_switch-ZB2GS`, { state_l1: 'ON' });
    expect(adapter.getState('0x00158dfffe000002')).toBeDefined();

    const remaining = (fixture as { ieee_address?: string }[]).filter(
      (device) => device.ieee_address !== '0x00158dfffe000002',
    );
    mqtt.deliver(`${BASE}/bridge/devices`, remaining);

    expect(adapter.getState('0x00158dfffe000002')).toBeUndefined();
  });

  it('stops listening after stop()', async () => {
    await adapter.stop();
    mqtt.deliver(`${BASE}/bridge/devices`, fixture);
    expect(adapter.getDevices()).toEqual([]);
  });
});

describe('what the bridge says about retaining', () => {
  const info = (config: unknown) => ({ config });

  let adapter: Zigbee2mqttAdapter;
  let mqtt: FakeMqtt;

  beforeEach(async () => {
    ({ adapter, mqtt } = await makeAdapter());
  });

  it('says nothing until the bridge has said something', () => {
    mqtt.deliver(`${BASE}/bridge/devices`, fixture, { retained: true });

    // Undefined rather than false: not knowing and knowing it is off are
    // different answers, and only one of them is worth showing.
    expect(adapter.getDevices().every((device) => device.retained === undefined)).toBe(true);
  });

  it('reads the setting a device carries, and the defaults it otherwise inherits', () => {
    mqtt.deliver(`${BASE}/bridge/devices`, fixture, { retained: true });
    mqtt.deliver(
      `${BASE}/bridge/info`,
      info({
        device_options: { retain: true },
        devices: { '0x00158dfffe000002': { retain: false } },
      }),
      { retained: true },
    );

    const devices = adapter.getDevices();
    expect(devices.find((device) => device.deviceId === '0x00158dfffe000002')?.retained).toBe(false);
    // Everything with no block of its own inherits the default.
    expect(devices.filter((device) => device.deviceId !== '0x00158dfffe000002').every((device) => device.retained === true)).toBe(true);
  });

  it('reads the broker-wide switch as off for everything', () => {
    mqtt.deliver(`${BASE}/bridge/devices`, fixture, { retained: true });
    mqtt.deliver(
      `${BASE}/bridge/info`,
      info({
        mqtt: { force_disable_retain: true },
        device_options: { retain: true },
        devices: { '0x00158dfffe000002': { retain: true } },
      }),
      { retained: true },
    );

    expect(adapter.getDevices().every((device) => device.retained === false)).toBe(true);
  });

  it('answers for a catalog that arrives after the config does', () => {
    mqtt.deliver(`${BASE}/bridge/info`, info({ device_options: { retain: true } }), {
      retained: true,
    });
    mqtt.deliver(`${BASE}/bridge/devices`, fixture, { retained: true });

    expect(adapter.getDevices().every((device) => device.retained === true)).toBe(true);
  });

  it('passes on what a device says about when it was last heard', () => {
    mqtt.deliver(`${BASE}/bridge/devices`, fixture, { retained: true });

    const updates: unknown[] = [];
    adapter.on('state', (update) => updates.push(update));
    mqtt.deliver('zigbee2mqtt/living_room_switch-ZB2GS', {
      state_l1: 'ON',
      last_seen: '2026-08-25T09:00:00Z',
    });

    // Not an expose, so no property carries it, and a retained message would
    // otherwise look as though the device had just spoken.
    expect(updates[0]).toMatchObject({ reportedLastSeen: '2026-08-25T09:00:00Z' });
  });
});
