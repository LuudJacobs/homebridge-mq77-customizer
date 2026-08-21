import { beforeEach, describe, expect, it } from 'vitest';

import { JsonTopicAdapter } from '../src/adapters/json-topic/adapter.js';
import type { SourceConfig } from '../src/adapters/types.js';
import { silentLogger } from '../src/logger.js';
import type { NormalisedProperty, StateUpdate } from '../src/model/types.js';
import { FakeMqtt } from './helpers/fake-mqtt.js';

/** Matches homebridge-broadlink-rm-blaster: retained state, commands on /set. */
const BROADLINK: SourceConfig = {
  id: 'broadlink',
  adapter: 'json-topic',
  baseTopic: 'broadlinkrm',
  setTopicSuffix: 'set',
};

/** Matches homebridge-withings-environment-data: one topic, read only. */
const WITHINGS: SourceConfig = {
  id: 'withings',
  adapter: 'json-topic',
  baseTopic: 'withingsenv',
};

async function makeAdapter(source: SourceConfig) {
  const mqtt = new FakeMqtt();
  const adapter = new JsonTopicAdapter({ source, mqtt: mqtt.asConnection(), log: silentLogger });
  await adapter.start();
  return { adapter, mqtt };
}

function propertyOf(adapter: JsonTopicAdapter, deviceId: string, key: string): NormalisedProperty {
  const property = adapter
    .getDevices()
    .find((device) => device.deviceId === deviceId)
    ?.properties.find((candidate) => candidate.key === key);
  if (!property) {
    throw new Error(`no property ${key} on ${deviceId}`);
  }
  return property;
}

describe('discovery', () => {
  let adapter: JsonTopicAdapter;
  let mqtt: FakeMqtt;

  beforeEach(async () => {
    ({ adapter, mqtt } = await makeAdapter(BROADLINK));
  });

  it('finds a device from its retained state', () => {
    mqtt.deliver('broadlinkrm/tv_lounge', { state: 'ON' }, { retained: true });
    expect(adapter.getDevices().map((device) => device.deviceId)).toEqual(['tv_lounge']);
  });

  it('accumulates keys across messages rather than trusting the first', () => {
    mqtt.deliver('broadlinkrm/fan_office', { state: 'ON', speed: 100, swing: 'ON' });
    // A partial update must not redefine the accessory down to one property.
    mqtt.deliver('broadlinkrm/fan_office', { speed: 50 });

    expect(propertyKeys(adapter, 'fan_office')).toEqual(['state', 'speed', 'swing']);
  });

  it('learns a key that only turns up later', () => {
    mqtt.deliver('broadlinkrm/lamp', { state: 'ON' });
    expect(propertyKeys(adapter, 'lamp')).toEqual(['state']);

    mqtt.deliver('broadlinkrm/lamp', { state: 'ON', level: 40 });
    expect(propertyKeys(adapter, 'lamp')).toEqual(['state', 'level']);
  });

  it('reports the topic it found the device on', () => {
    mqtt.deliver('broadlinkrm/tv_lounge', { state: 'ON' });
    expect(adapter.getDevices()[0]?.topic).toBe('broadlinkrm/tv_lounge');
  });

  it('keeps devices apart by topic', () => {
    mqtt.deliver('broadlinkrm/one', { state: 'ON' });
    mqtt.deliver('broadlinkrm/two', { state: 'OFF' });
    expect(adapter.getDevices()).toHaveLength(2);
  });

  it('ignores the commands it publishes itself', () => {
    mqtt.deliver('broadlinkrm/lamp/set', { state: 'ON' });
    expect(adapter.getDevices()).toEqual([]);
  });

  it('drops a device whose retained topic is cleared', () => {
    mqtt.deliver('broadlinkrm/test_tv', { state: 'ON' });
    expect(adapter.getDevices()).toHaveLength(1);

    // An empty payload is how a retained topic is cleared.
    mqtt.deliver('broadlinkrm/test_tv', '');
    expect(adapter.getDevices()).toEqual([]);
  });

  it('says so when a device goes away', () => {
    let announcements = 0;
    mqtt.deliver('broadlinkrm/test_tv', { state: 'ON' });
    adapter.on('devices', () => (announcements += 1));

    mqtt.deliver('broadlinkrm/test_tv', '');
    expect(announcements).toBe(1);

    // Clearing a topic we never had is not news.
    mqtt.deliver('broadlinkrm/never_seen', '');
    expect(announcements).toBe(1);
  });

  it('ignores payloads it cannot read', () => {
    mqtt.deliver('broadlinkrm/lamp', 'not json');
    mqtt.deliver('broadlinkrm/other', '"just a string"');
    expect(adapter.getDevices()).toEqual([]);
  });

  it('announces the catalog only when something new appears', () => {
    let announcements = 0;
    adapter.on('devices', () => (announcements += 1));

    mqtt.deliver('broadlinkrm/lamp', { state: 'ON' });
    mqtt.deliver('broadlinkrm/lamp', { state: 'OFF' });
    mqtt.deliver('broadlinkrm/lamp', { state: 'ON' });
    expect(announcements).toBe(1);

    mqtt.deliver('broadlinkrm/lamp', { level: 30 });
    expect(announcements).toBe(2);
  });
});

function propertyKeys(adapter: JsonTopicAdapter, deviceId: string): string[] {
  return (
    adapter
      .getDevices()
      .find((device) => device.deviceId === deviceId)
      ?.properties.map((property) => property.key) ?? []
  );
}

describe('known keys', () => {
  let adapter: JsonTopicAdapter;
  let mqtt: FakeMqtt;

  beforeEach(async () => {
    ({ adapter, mqtt } = await makeAdapter(BROADLINK));
    mqtt.deliver('broadlinkrm/fan_office', {
      state: 'ON',
      level: 40,
      speed: 60,
      swing: 'OFF',
      temperature: 21.5,
      humidity: 47,
    });
  });

  it('types on/off as binary with the values this publisher uses', () => {
    const state = propertyOf(adapter, 'fan_office', 'state');
    expect(state.type).toBe('binary');
    expect(state.onValue).toBe('ON');
    expect(state.offValue).toBe('OFF');
  });

  it('gives level and speed a percentage range', () => {
    expect(propertyOf(adapter, 'fan_office', 'level')).toMatchObject({ min: 0, max: 100 });
    expect(propertyOf(adapter, 'fan_office', 'speed')).toMatchObject({ min: 0, max: 100 });
  });

  it('carries units for the readings', () => {
    expect(propertyOf(adapter, 'fan_office', 'temperature').unit).toBe('°C');
    expect(propertyOf(adapter, 'fan_office', 'humidity').unit).toBe('%');
  });

  it('makes controls writable and readings read only', () => {
    expect(propertyOf(adapter, 'fan_office', 'state').access).toEqual({
      readable: true,
      writable: true,
    });
    expect(propertyOf(adapter, 'fan_office', 'temperature').access).toEqual({
      readable: true,
      writable: false,
    });
  });

  it('points writes at the command topic', () => {
    expect(propertyOf(adapter, 'fan_office', 'state').setTopic).toBe('broadlinkrm/fan_office/set');
    expect(propertyOf(adapter, 'fan_office', 'temperature').setTopic).toBeUndefined();
  });
});

describe('unknown keys', () => {
  it('keeps them, typed from the value, rather than dropping them', async () => {
    const { adapter, mqtt } = await makeAdapter(BROADLINK);
    mqtt.deliver('broadlinkrm/odd', {
      state: 'ON',
      learning: true,
      repeats: 3,
      last_code: 'JgBQAAAB',
    });

    // Dropping these would take them out of the rules engine as well.
    expect(propertyOf(adapter, 'odd', 'learning').type).toBe('binary');
    expect(propertyOf(adapter, 'odd', 'repeats').type).toBe('numeric');
    expect(propertyOf(adapter, 'odd', 'last_code').type).toBe('text');
  });

  it('never makes one writable, since nothing says it can be set', async () => {
    const { adapter, mqtt } = await makeAdapter(BROADLINK);
    mqtt.deliver('broadlinkrm/odd', { repeats: 3 });
    expect(propertyOf(adapter, 'odd', 'repeats').access.writable).toBe(false);
  });

  it('skips values it has no way to represent', async () => {
    const { adapter, mqtt } = await makeAdapter(BROADLINK);
    mqtt.deliver('broadlinkrm/odd', { state: 'ON', nested: { a: 1 }, list: [1, 2] });
    expect(propertyKeys(adapter, 'odd')).toEqual(['state']);
  });

  it('reads a boolean publisher as booleans, not as ON and OFF', async () => {
    const { adapter, mqtt } = await makeAdapter(BROADLINK);
    mqtt.deliver('broadlinkrm/flag', { state: true });
    const state = propertyOf(adapter, 'flag', 'state');
    expect(state.onValue).toBe(true);
    expect(state.offValue).toBe(false);
  });
});

describe('functions described in the config', () => {
  /** A fan that reports nothing but its state until someone changes the rest. */
  const FAN: SourceConfig = {
    ...BROADLINK,
    devices: [{ topic: 'fan_office', properties: ['speed', 'swing'] }],
  };

  it('gives a device the functions it has not mentioned yet', async () => {
    const { adapter, mqtt } = await makeAdapter(FAN);
    mqtt.deliver('broadlinkrm/fan_office', { state: 'ON' });

    expect(propertyKeys(adapter, 'fan_office')).toEqual(['speed', 'swing', 'state']);
  });

  it('describes them the way the adapter always would', async () => {
    const { adapter, mqtt } = await makeAdapter(FAN);
    mqtt.deliver('broadlinkrm/fan_office', { state: 'ON' });

    expect(propertyOf(adapter, 'fan_office', 'speed')).toMatchObject({ min: 0, max: 100 });
    expect(propertyOf(adapter, 'fan_office', 'swing')).toMatchObject({
      type: 'binary',
      onValue: 'ON',
      offValue: 'OFF',
    });
  });

  it('makes them settable, since that is the point of describing them', async () => {
    const { adapter, mqtt } = await makeAdapter(FAN);
    mqtt.deliver('broadlinkrm/fan_office', { state: 'ON' });

    expect(propertyOf(adapter, 'fan_office', 'speed').setTopic).toBe('broadlinkrm/fan_office/set');
  });

  it('leaves them read only when the source has no command topic', async () => {
    const { adapter, mqtt } = await makeAdapter({ ...FAN, setTopicSuffix: undefined });
    mqtt.deliver('broadlinkrm/fan_office', { state: 'ON' });

    expect(propertyOf(adapter, 'fan_office', 'speed').access.writable).toBe(false);
  });

  it('corrects the guess once a real value turns up', async () => {
    const { adapter, mqtt } = await makeAdapter(FAN);
    mqtt.deliver('broadlinkrm/fan_office', { state: true });
    // Described without a sample, so it assumed the strings this family uses.
    expect(propertyOf(adapter, 'fan_office', 'swing').onValue).toBe('ON');

    // This publisher speaks booleans, and sending it "ON" would do nothing.
    mqtt.deliver('broadlinkrm/fan_office', { swing: false });
    expect(propertyOf(adapter, 'fan_office', 'swing')).toMatchObject({
      onValue: true,
      offValue: false,
    });
  });

  it('leaves a reported function alone rather than describing over it', async () => {
    const { adapter, mqtt } = await makeAdapter(FAN);
    mqtt.deliver('broadlinkrm/fan_office', { state: 'ON', speed: 40 });

    expect(adapter.getState('fan_office')).toMatchObject({ speed: 40 });
    expect(propertyOf(adapter, 'fan_office', 'speed').access.writable).toBe(true);
  });

  it('refuses a name it has no meaning for, and says what it knows', async () => {
    const warnings: string[] = [];
    const mqtt = new FakeMqtt();
    const adapter = new JsonTopicAdapter({
      source: { ...BROADLINK, devices: [{ topic: 'fan_office', properties: ['wobble'] }] },
      mqtt: mqtt.asConnection(),
      log: { ...silentLogger, warn: (message: string) => warnings.push(message) },
    });
    await adapter.start();
    mqtt.deliver('broadlinkrm/fan_office', { state: 'ON' });

    // Guessing a type from a name alone would be worse than saying no.
    expect(propertyKeys(adapter, 'fan_office')).toEqual(['state']);
    expect(warnings[0]).toContain('wobble');
    expect(warnings[0]).toContain('speed');
  });

  it('says nothing about a device that is described but never speaks', async () => {
    const { adapter, mqtt } = await makeAdapter(FAN);
    mqtt.deliver('broadlinkrm/other', { state: 'ON' });

    // The catalog is built from what the broker has said, and an accessory
    // conjured from the config alone would be one nothing can answer for.
    expect(adapter.getDevices().map((device) => device.deviceId)).toEqual(['other']);
  });
});

describe('a read only source', () => {
  it('leaves everything read only when there is no command topic', async () => {
    const { adapter, mqtt } = await makeAdapter(WITHINGS);
    mqtt.deliver('withingsenv/ws-50', { temperature: 25.2, co2_levels: 674 });

    expect(propertyOf(adapter, 'ws-50', 'temperature').access.writable).toBe(false);
    expect(propertyOf(adapter, 'ws-50', 'co2_levels').access.writable).toBe(false);
    expect(propertyOf(adapter, 'ws-50', 'co2_levels').unit).toBe('ppm');
  });

  it('finds the device on a single fixed topic', async () => {
    const { adapter, mqtt } = await makeAdapter(WITHINGS);
    mqtt.deliver('withingsenv/ws-50', { temperature: 25.2 });
    expect(adapter.getDevices().map((device) => device.deviceId)).toEqual(['ws-50']);
  });
});

describe('state', () => {
  it('reports values and merges partial updates', async () => {
    const { adapter, mqtt } = await makeAdapter(BROADLINK);
    mqtt.deliver('broadlinkrm/fan', { state: 'ON', speed: 100, swing: 'ON' });
    mqtt.deliver('broadlinkrm/fan', { speed: 50 });

    expect(adapter.getState('fan')).toEqual({ state: 'ON', speed: 50, swing: 'ON' });
  });

  it('flags retained values so rules do not fire on a replay', async () => {
    const { adapter, mqtt } = await makeAdapter(BROADLINK);
    const updates: StateUpdate[] = [];
    adapter.on('state', (update) => updates.push(update));

    mqtt.deliver('broadlinkrm/fan', { state: 'ON' }, { retained: true });
    mqtt.deliver('broadlinkrm/fan', { state: 'OFF' });

    expect(updates.map((update) => update.retained)).toEqual([true, false]);
  });

  it('stops listening after stop()', async () => {
    const { adapter, mqtt } = await makeAdapter(BROADLINK);
    await adapter.stop();
    mqtt.deliver('broadlinkrm/fan', { state: 'ON' });
    expect(adapter.getDevices()).toEqual([]);
  });
});
