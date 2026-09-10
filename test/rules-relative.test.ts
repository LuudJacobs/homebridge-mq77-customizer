import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { Catalog } from '../src/catalog.js';
import { silentLogger } from '../src/logger.js';
import { RulesEngine } from '../src/rules/engine.js';
import type { Rule } from '../src/rules/types.js';
import { Store } from '../src/store.js';
import fixture from './fixtures/bridge-devices.json' with { type: 'json' };
import { FakeMqtt } from './helpers/fake-mqtt.js';

/** The thermostat, which is the reason this exists. */
const CLIMATE = {
  id: '0x00158dfffe000004',
  topic: 'zigbee2mqtt/living_room_climate-w100',
  key: 'occupied_heating_setpoint',
};
/** The rocker whose left button sets the rules here off. */
const ROCKER = { id: '0x00158dfffe000005', topic: 'zigbee2mqtt/bedroom_rocker-wrs02' };
/** A socket, for the times a value that is not a number is asked to move. */
const SOCKET = { id: '0x00158dfffe000006', topic: 'zigbee2mqtt/living_room_lamp-socket' };

function warmer(overrides: Record<string, unknown> = {}, by = 0.5, way = 'add'): Rule {
  return {
    id: 'r1',
    name: 'A bit warmer',
    enabled: true,
    trigger: {
      sourceId: 'zigbee',
      deviceId: ROCKER.id,
      propertyKey: 'action',
      match: { kind: 'equals', value: 'single_left' },
    },
    actions: [
      {
        sourceId: 'zigbee',
        deviceId: CLIMATE.id,
        propertyKey: CLIMATE.key,
        valueFrom: { kind: way as 'add' | 'subtract' },
        value: by,
        ...overrides,
      },
    ],
    rateLimitMs: 0,
  } as Rule;
}

async function harness(rules: Rule[]) {
  const directory = await mkdtemp(join(tmpdir(), 'mq77-relative-'));
  const store = new Store(join(directory, 'state.json'), silentLogger);
  await store.load();
  store.update((state) => {
    state.rules = rules;
  });

  const mqtt = new FakeMqtt();
  const catalog = new Catalog(mqtt.asConnection(), silentLogger);
  await catalog.start([{ id: 'zigbee', adapter: 'zigbee2mqtt', baseTopic: 'zigbee2mqtt' }]);
  mqtt.deliver('zigbee2mqtt/bridge/devices', fixture, { retained: true });

  const engine = new RulesEngine(catalog, store, mqtt.asConnection(), silentLogger);
  catalog.on('state', (update) => engine.handleState(update));
  return { engine, mqtt };
}

/** The left button, which is what every rule here is set off by. */
const press = (mqtt: FakeMqtt) => mqtt.deliver(ROCKER.topic, { action: 'single_left' });

/** What was published, once the state deliveries are out of the way. */
const sent = (mqtt: FakeMqtt) =>
  mqtt.published.map((message) => ({ topic: message.topic, payload: message.payload }));

describe('an action that moves a value rather than setting one', () => {
  it('adds to what the device last said it was at', async () => {
    const { mqtt } = await harness([warmer()]);
    mqtt.deliver(CLIMATE.topic, { [CLIMATE.key]: 20 });
    mqtt.published.length = 0;

    press(mqtt);

    expect(sent(mqtt)).toEqual([
      { topic: `${CLIMATE.topic}/set`, payload: `{"${CLIMATE.key}":20.5}` },
    ]);
  });

  it('subtracts the other way round', async () => {
    const { mqtt } = await harness([warmer({}, 1, 'subtract')]);
    mqtt.deliver(CLIMATE.topic, { [CLIMATE.key]: 20 });
    mqtt.published.length = 0;

    press(mqtt);

    expect(sent(mqtt)[0]?.payload).toBe(`{"${CLIMATE.key}":19}`);
  });

  it('sends a number somebody would write, not what the arithmetic says', async () => {
    // 20.2 + 0.5 is 20.700000000000003 in binary floating point.
    const { mqtt } = await harness([warmer()]);
    mqtt.deliver(CLIMATE.topic, { [CLIMATE.key]: 20.2 });
    mqtt.published.length = 0;

    press(mqtt);

    expect(sent(mqtt)[0]?.payload).toBe(`{"${CLIMATE.key}":20.7}`);
  });

  it('sends past the top of the range, and lets the device be the judge of that', async () => {
    // The setpoint stops at 30. A rule that says warmer says warmer.
    const { mqtt } = await harness([warmer({}, 2)]);
    mqtt.deliver(CLIMATE.topic, { [CLIMATE.key]: 30 });
    mqtt.published.length = 0;

    press(mqtt);

    expect(sent(mqtt)[0]?.payload).toBe(`{"${CLIMATE.key}":32}`);
  });

  it('reads the value when it sends, not when the rule fired', async () => {
    vi.useFakeTimers();
    try {
      const { mqtt } = await harness([warmer({ delayMs: 60_000 })]);
      mqtt.deliver(CLIMATE.topic, { [CLIMATE.key]: 20 });
      mqtt.published.length = 0;

      press(mqtt);
      expect(sent(mqtt)).toEqual([]);

      // Somebody turns it up by hand while the rule is waiting.
      mqtt.deliver(CLIMATE.topic, { [CLIMATE.key]: 22 });
      await vi.advanceTimersByTimeAsync(61_000);

      // Half a degree on top of 22, not on top of the 20 it was set off at.
      expect(sent(mqtt)[0]?.payload).toBe(`{"${CLIMATE.key}":22.5}`);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses to move something that is not a number', async () => {
    const { engine, mqtt } = await harness([
      warmer({ deviceId: SOCKET.id, propertyKey: 'state' }),
    ]);
    mqtt.deliver(SOCKET.topic, { state: 'ON' });
    mqtt.published.length = 0;

    press(mqtt);

    expect(sent(mqtt)).toEqual([]);
    expect(engine.getLog()[0]).toMatchObject({ outcome: 'failed' });
    expect(engine.getLog()[0]?.detail).toContain('not a number');
  });
});

describe('a value the device has never mentioned', () => {
  it('asks for it, and acts on the answer', async () => {
    const { mqtt } = await harness([warmer()]);
    mqtt.published.length = 0;

    press(mqtt);

    // Nothing set yet: it has asked, in the words Zigbee2MQTT answers to.
    expect(sent(mqtt)).toEqual([
      { topic: `${CLIMATE.topic}/get`, payload: `{"${CLIMATE.key}":""}` },
    ]);

    mqtt.deliver(CLIMATE.topic, { [CLIMATE.key]: 18 });

    expect(sent(mqtt).at(-1)).toEqual({
      topic: `${CLIMATE.topic}/set`,
      payload: `{"${CLIMATE.key}":18.5}`,
    });
  });

  it('gives up out loud when the answer never comes', async () => {
    vi.useFakeTimers();
    try {
      const { engine, mqtt } = await harness([warmer()]);
      mqtt.published.length = 0;

      press(mqtt);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(sent(mqtt).filter((message) => message.topic.endsWith('/set'))).toEqual([]);
      expect(engine.getLog()[0]).toMatchObject({ outcome: 'failed' });
      expect(engine.getLog()[0]?.detail).toContain('did not say what it is');
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks once for two rules waiting on the same value', async () => {
    const second = { ...warmer(), id: 'r2', name: 'Warmer still' };
    const { mqtt } = await harness([warmer(), second]);
    mqtt.published.length = 0;

    press(mqtt);

    const asks = sent(mqtt).filter((message) => message.topic.endsWith('/get'));
    expect(asks).toHaveLength(2);

    // One answer, and both rules act on it.
    mqtt.deliver(CLIMATE.topic, { [CLIMATE.key]: 18 });
    expect(sent(mqtt).filter((message) => message.topic.endsWith('/set'))).toHaveLength(2);
  });

  it('says so when there is nobody to ask', async () => {
    // `local_temperature` is published and read only, so it is not settable
    // either. `external_temperature` is settable and not askable: access 3.
    const { engine, mqtt } = await harness([warmer({ propertyKey: 'external_temperature' })]);
    mqtt.published.length = 0;

    press(mqtt);

    expect(sent(mqtt)).toEqual([]);
    expect(engine.getLog()[0]).toMatchObject({ outcome: 'failed' });
    expect(engine.getLog()[0]?.detail).toContain('cannot be asked');
  });
});
