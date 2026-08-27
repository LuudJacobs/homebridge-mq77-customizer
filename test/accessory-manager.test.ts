import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Characteristic, Service } from 'hap-nodejs';
import { beforeEach, describe, expect, it } from 'vitest';

import { Catalog } from '../src/catalog.js';
import { AccessoryManager } from '../src/homekit/manager.js';
import { silentLogger } from '../src/logger.js';
import { Store } from '../src/store.js';
import type { DeviceExposure } from '../src/store.js';
import fixture from './fixtures/bridge-devices.json' with { type: 'json' };
import { cachedAccessory, fakeApi, type FakeApi } from './helpers/fake-homebridge.js';
import { FakeMqtt } from './helpers/fake-mqtt.js';

const DUAL = '0x00158dfffe000002';
const DUAL_TOPIC = 'zigbee2mqtt/living_room_switch-ZB2GS';

interface Harness {
  manager: AccessoryManager;
  store: Store;
  mqtt: FakeMqtt;
  catalog: Catalog;
  hb: FakeApi;
}

async function harness(): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'mq77-customizer-hk-'));
  const store = new Store(join(directory, 'state.json'), silentLogger);
  await store.load();

  const mqtt = new FakeMqtt();
  const catalog = new Catalog(mqtt.asConnection(), silentLogger);
  await catalog.start([{ id: 'zigbee', adapter: 'zigbee2mqtt', baseTopic: 'zigbee2mqtt' }]);
  mqtt.deliver('zigbee2mqtt/bridge/devices', fixture, { retained: true });
  mqtt.deliver(DUAL_TOPIC, { state_l1: 'ON', state_l2: 'OFF' });

  const hb = fakeApi();
  const manager = new AccessoryManager(hb.api, silentLogger, catalog, store, mqtt.asConnection());
  return { manager, store, mqtt, catalog, hb };
}

function expose(store: Store, exposure: DeviceExposure): void {
  store.setExposure(`zigbee:${DUAL}`, exposure);
}

describe('AccessoryManager', () => {
  let context: Harness;

  beforeEach(async () => {
    context = await harness();
  });

  it('publishes nothing until something is ticked', () => {
    context.manager.sync();
    expect(context.hb.registered).toHaveLength(0);
  });

  it('publishes an accessory when a property is ticked', () => {
    expose(context.store, { properties: ['state_l1'] });
    context.manager.sync();

    expect(context.hb.registered).toHaveLength(1);
    const accessory = context.hb.registered[0]!;
    expect(accessory.displayName).toBe('living_room_switch-ZB2GS');
    expect(accessory.getServiceById(Service.Switch, 'state_l1')).toBeDefined();
  });

  it('does not register the same accessory twice on repeated syncs', () => {
    expose(context.store, { properties: ['state_l1'] });
    context.manager.sync();
    context.manager.sync();
    context.manager.sync();
    expect(context.hb.registered).toHaveLength(1);
    expect(context.hb.unregistered).toHaveLength(0);
  });

  it('removes the accessory when the last property is unticked', () => {
    expose(context.store, { properties: ['state_l1'] });
    context.manager.sync();
    expose(context.store, { properties: [] });
    context.manager.sync();

    expect(context.hb.unregistered).toHaveLength(1);
    expect(context.hb.unregistered[0]?.UUID).toBe(context.hb.registered[0]?.UUID);
  });

  it('adds a second service without re-registering the accessory', () => {
    expose(context.store, { properties: ['state_l1'] });
    context.manager.sync();
    expose(context.store, { properties: ['state_l1', 'state_l2'] });
    context.manager.sync();

    expect(context.hb.registered).toHaveLength(1);
    const accessory = context.hb.registered[0]!;
    expect(accessory.getServiceById(Service.Switch, 'state_l1')).toBeDefined();
    expect(accessory.getServiceById(Service.Switch, 'state_l2')).toBeDefined();
  });

  it('swaps the service type when the tile changes', () => {
    expose(context.store, { properties: ['state_l1'] });
    context.manager.sync();
    expose(context.store, { properties: ['state_l1'], tileTypes: { l1: 'Lightbulb' } });
    context.manager.sync();

    const accessory = context.hb.registered[0]!;
    expect(accessory.getServiceById(Service.Switch, 'state_l1')).toBeUndefined();
    expect(accessory.getServiceById(Service.Lightbulb, 'state_l1')).toBeDefined();
  });

  it('splits into two accessories and back again', () => {
    expose(context.store, { properties: ['state_l1', 'state_l2'], splitEndpoints: true });
    context.manager.sync();
    expect(context.hb.registered).toHaveLength(2);

    expose(context.store, { properties: ['state_l1', 'state_l2'], splitEndpoints: false });
    context.manager.sync();
    // The two split accessories go, one combined accessory arrives.
    expect(context.hb.unregistered).toHaveLength(2);
    expect(context.hb.registered).toHaveLength(3);
  });

  it('adopts a cached accessory rather than registering a duplicate', () => {
    context.manager.restore(cachedAccessory('living_room_switch-ZB2GS', `zigbee:${DUAL}`));
    expose(context.store, { properties: ['state_l1'] });
    context.manager.sync();

    expect(context.hb.registered).toHaveLength(0);
    expect(context.hb.unregistered).toHaveLength(0);
  });

  it('removes cached accessories that nothing claims', () => {
    context.manager.restore(cachedAccessory('Long gone', 'zigbee:0xdeadbeef'));
    context.manager.sync();

    expect(context.hb.unregistered).toHaveLength(1);
    expect(context.hb.unregistered[0]?.displayName).toBe('Long gone');
  });

  it('drops accessories for a device that left the network', () => {
    expose(context.store, { properties: ['state_l1'] });
    context.manager.sync();
    expect(context.hb.registered).toHaveLength(1);

    const remaining = (fixture as { ieee_address?: string }[]).filter(
      (device) => device.ieee_address !== DUAL,
    );
    context.mqtt.deliver('zigbee2mqtt/bridge/devices', remaining);
    context.manager.sync();

    expect(context.hb.unregistered).toHaveLength(1);
  });

  it('reads the current value through the characteristic', async () => {
    expose(context.store, { properties: ['state_l1'] });
    context.manager.sync();

    const service = context.hb.registered[0]!.getServiceById(Service.Switch, 'state_l1')!;
    await expect(service.getCharacteristic(Characteristic.On).handleGetRequest()).resolves.toBe(
      true,
    );

    context.mqtt.deliver(DUAL_TOPIC, { state_l1: 'OFF' });
    await expect(service.getCharacteristic(Characteristic.On).handleGetRequest()).resolves.toBe(
      false,
    );
  });

  it('publishes to the set topic when HomeKit switches it', async () => {
    expose(context.store, { properties: ['state_l1'] });
    context.manager.sync();

    const service = context.hb.registered[0]!.getServiceById(Service.Switch, 'state_l1')!;
    await service.getCharacteristic(Characteristic.On).handleSetRequest(false);

    expect(context.mqtt.published).toEqual([
      { topic: `${DUAL_TOPIC}/set`, payload: '{"state_l1":"OFF"}', retain: false },
    ]);
  });

  it('pushes incoming values into the characteristic', () => {
    expose(context.store, { properties: ['state_l1'] });
    context.manager.sync();
    const service = context.hb.registered[0]!.getServiceById(Service.Switch, 'state_l1')!;
    expect(service.getCharacteristic(Characteristic.On).value).toBe(true);

    context.catalog.on('state', (update) => context.manager.handleState(update));
    context.mqtt.deliver(DUAL_TOPIC, { state_l1: 'OFF' });

    expect(service.getCharacteristic(Characteristic.On).value).toBe(false);
  });

  it('does not stack duplicate handlers when synced repeatedly', async () => {
    expose(context.store, { properties: ['state_l1'] });
    context.manager.sync();
    context.manager.sync();
    context.manager.sync();

    const service = context.hb.registered[0]!.getServiceById(Service.Switch, 'state_l1')!;
    await service.getCharacteristic(Characteristic.On).handleSetRequest(false);

    // One publish, not three.
    expect(context.mqtt.published).toHaveLength(1);
  });
});

describe('starting up before the broker answers', () => {
  /** A harness where nothing has arrived on bridge/devices yet. */
  async function coldStart() {
    const directory = await mkdtemp(join(tmpdir(), 'mqtt-customizer-cold-'));
    const store = new Store(join(directory, 'state.json'), silentLogger);
    await store.load();
    store.setExposure(`zigbee:${DUAL}`, { properties: ['state_l1'] });

    const mqtt = new FakeMqtt();
    const catalog = new Catalog(mqtt.asConnection(), silentLogger);
    await catalog.start([{ id: 'zigbee', adapter: 'zigbee2mqtt', baseTopic: 'zigbee2mqtt' }]);

    const hb = fakeApi();
    const manager = new AccessoryManager(hb.api, silentLogger, catalog, store, mqtt.asConnection());
    return { manager, mqtt, hb };
  }

  it('keeps cached accessories until the source has said what it has', async () => {
    const context = await coldStart();
    context.manager.restore(cachedAccessory('living_room_switch-ZB2GS', `zigbee:${DUAL}`));

    // Homebridge calls this before anything has come back from the broker.
    // Removing an accessory here tells HomeKit to forget which room it is in,
    // and adding it back a moment later does not undo that.
    context.manager.sync();
    expect(context.hb.unregistered).toEqual([]);
  });

  it('adopts them once the catalog arrives, without registering anew', async () => {
    const context = await coldStart();
    context.manager.restore(cachedAccessory('living_room_switch-ZB2GS', `zigbee:${DUAL}`));
    context.manager.sync();

    context.mqtt.deliver('zigbee2mqtt/bridge/devices', fixture, { retained: true });
    context.manager.sync();

    expect(context.hb.unregistered).toEqual([]);
    expect(context.hb.registered).toEqual([]);
  });

  it('still clears one whose device is genuinely gone', async () => {
    const context = await coldStart();
    context.manager.restore(cachedAccessory('Long gone', 'zigbee:0xdeadbeef'));

    context.mqtt.deliver('zigbee2mqtt/bridge/devices', fixture, { retained: true });
    context.manager.sync();

    // The source has spoken now, and it does not have that device.
    expect(context.hb.unregistered).toHaveLength(1);
    expect(context.hb.unregistered[0]?.displayName).toBe('Long gone');
  });

  it('waits for every source when an accessory does not say where it came from', async () => {
    const context = await coldStart();
    // Cached by a version that stored no plan, so there is nothing to check
    // against and guessing would be destructive.
    context.manager.restore(cachedAccessory('From who knows where', 'zigbee:0xold'));
    context.manager.sync();
    expect(context.hb.unregistered).toEqual([]);
  });
});
