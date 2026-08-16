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
      'zigbee2mqtt/#',
    ]);
  });

  it('builds the catalog from bridge/devices', () => {
    mqtt.deliver(`${BASE}/bridge/devices`, fixture, { retained: true });

    const names = adapter.getDevices().map((device) => device.deviceId);
    expect(names).toEqual([
      '0xf044d3fffe024659',
      '0x1cc089fffe39c60e',
      '0x54ef4410013bd210',
      '0x54ef44100169b28a',
      '0xa4c138ae47fdd9c3',
    ]);
  });

  it('skips the coordinator, disabled devices and devices with no definition', () => {
    mqtt.deliver(`${BASE}/bridge/devices`, fixture);
    const ids = adapter.getDevices().map((device) => device.deviceId);
    expect(ids).not.toContain('0x00124b0032d464c8');
    expect(ids).not.toContain('0x0000000000000001');
    expect(ids).not.toContain('0x0000000000000002');
  });

  it('prefers the user description over the friendly name', () => {
    mqtt.deliver(`${BASE}/bridge/devices`, fixture);
    const w100 = adapter.getDevices().find((d) => d.deviceId === '0x54ef4410013bd210');
    expect(w100?.name).toBe('Thermostaat woonkamer');
    expect(w100?.manufacturer).toBe('Aqara');
    expect(w100?.model).toBe('TH-S04D');
  });

  it('records state for known properties', () => {
    mqtt.deliver(`${BASE}/bridge/devices`, fixture);
    mqtt.deliver(`${BASE}/woonkamer_lampen-ZB2GS`, { state_l1: 'ON', state_l2: 'OFF' });

    expect(adapter.getState('0xf044d3fffe024659')).toEqual({
      state_l1: 'ON',
      state_l2: 'OFF',
    });
  });

  it('reads values out of composites', () => {
    mqtt.deliver(`${BASE}/bridge/devices`, fixture);
    mqtt.deliver(`${BASE}/keuken_dimmer-candeo`, {
      state: 'ON',
      brightness: 128,
      level_config: { on_level: 40 },
    });

    expect(adapter.getState('0x1cc089fffe39c60e')).toEqual({
      state: 'ON',
      brightness: 128,
      'level_config.on_level': 40,
    });
  });

  it('ignores properties that are not published by the device', () => {
    mqtt.deliver(`${BASE}/bridge/devices`, fixture);
    // detach_relay_outlet1 is access 2, write only, so it must not be recorded
    // even when something echoes it back.
    mqtt.deliver(`${BASE}/woonkamer_lampen-ZB2GS`, {
      state_l1: 'ON',
      detach_relay_mode: { detach_relay_outlet1: 'ENABLE' },
    });

    expect(adapter.getState('0xf044d3fffe024659')).toEqual({ state_l1: 'ON' });
  });

  it('merges partial updates into the known state', () => {
    mqtt.deliver(`${BASE}/bridge/devices`, fixture);
    mqtt.deliver(`${BASE}/woonkamer_lampen-ZB2GS`, { state_l1: 'ON', state_l2: 'ON' });
    mqtt.deliver(`${BASE}/woonkamer_lampen-ZB2GS`, { state_l2: 'OFF' });

    expect(adapter.getState('0xf044d3fffe024659')).toEqual({
      state_l1: 'ON',
      state_l2: 'OFF',
    });
  });

  it('flags retained messages so rules can ignore replayed state', () => {
    const updates: StateUpdate[] = [];
    adapter.on('state', (update) => updates.push(update));

    mqtt.deliver(`${BASE}/bridge/devices`, fixture);
    mqtt.deliver(`${BASE}/woonkamer_lampen-ZB2GS`, { state_l1: 'ON' }, { retained: true });
    mqtt.deliver(`${BASE}/woonkamer_lampen-ZB2GS`, { state_l1: 'OFF' });

    expect(updates.map((update) => update.retained)).toEqual([true, false]);
    expect(updates[0]?.changes).toEqual({ state_l1: 'ON' });
  });

  it('ignores command topics, availability and bridge traffic', () => {
    const updates: StateUpdate[] = [];
    mqtt.deliver(`${BASE}/bridge/devices`, fixture);
    adapter.on('state', (update) => updates.push(update));

    mqtt.deliver(`${BASE}/woonkamer_lampen-ZB2GS/set`, { state_l1: 'ON' });
    mqtt.deliver(`${BASE}/woonkamer_lampen-ZB2GS/get`, { state_l1: '' });
    mqtt.deliver(`${BASE}/woonkamer_lampen-ZB2GS/availability`, { state: 'online' });
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
    mqtt.deliver(`${BASE}/woonkamer_lampen-ZB2GS`, 'not json');
    expect(adapter.getState('0xf044d3fffe024659')).toBeUndefined();
  });

  it('rebuilds topics when a device is renamed', () => {
    mqtt.deliver(`${BASE}/bridge/devices`, fixture);
    const renamed = JSON.parse(JSON.stringify(fixture)) as { friendly_name: string }[];
    const entry = renamed.find((d) => d.friendly_name === 'woonkamer_lampen-ZB2GS');
    entry!.friendly_name = 'woonkamer_lampen';
    mqtt.deliver(`${BASE}/bridge/devices`, renamed);

    mqtt.deliver(`${BASE}/woonkamer_lampen`, { state_l1: 'ON' });
    expect(adapter.getState('0xf044d3fffe024659')).toEqual({ state_l1: 'ON' });

    const device = adapter.getDevices().find((d) => d.deviceId === '0xf044d3fffe024659');
    expect(device?.properties[0]?.stateTopic).toBe('zigbee2mqtt/woonkamer_lampen');
    expect(device?.properties[0]?.setTopic).toBe('zigbee2mqtt/woonkamer_lampen/set');
  });

  it('forgets state for devices that leave the network', () => {
    mqtt.deliver(`${BASE}/bridge/devices`, fixture);
    mqtt.deliver(`${BASE}/woonkamer_lampen-ZB2GS`, { state_l1: 'ON' });
    expect(adapter.getState('0xf044d3fffe024659')).toBeDefined();

    const remaining = (fixture as { ieee_address?: string }[]).filter(
      (device) => device.ieee_address !== '0xf044d3fffe024659',
    );
    mqtt.deliver(`${BASE}/bridge/devices`, remaining);

    expect(adapter.getState('0xf044d3fffe024659')).toBeUndefined();
  });

  it('stops listening after stop()', async () => {
    await adapter.stop();
    mqtt.deliver(`${BASE}/bridge/devices`, fixture);
    expect(adapter.getDevices()).toEqual([]);
  });
});
