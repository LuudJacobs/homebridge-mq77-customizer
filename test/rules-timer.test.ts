import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { Catalog } from '../src/catalog.js';
import { silentLogger } from '../src/logger.js';
import { RulesEngine } from '../src/rules/engine.js';
import type { TimerRule } from '../src/rules/types.js';
import { Store } from '../src/store.js';
import fixture from './fixtures/bridge-devices.json' with { type: 'json' };
import { FakeMqtt } from './helpers/fake-mqtt.js';

const LAMP = { id: '0x1cc089fffe39c60e', topic: 'zigbee2mqtt/keuken_dimmer-candeo' };
const SOCKET = { id: '0xa4c138ae47fdd9c3', topic: 'zigbee2mqtt/woonkamer_bank_lamp-socket' };

function timerRule(overrides: Partial<TimerRule> = {}): TimerRule {
  return {
    id: 't1',
    kind: 'timer',
    name: 'Light out',
    enabled: true,
    triggers: [
      {
        sourceId: 'zigbee',
        deviceId: LAMP.id,
        propertyKey: 'state',
        match: { kind: 'changedTo', value: 'ON' },
      },
    ],
    waitMs: 30_000,
    actions: [{ sourceId: 'zigbee', deviceId: LAMP.id, propertyKey: 'state', value: 'OFF' }],
    ...overrides,
  };
}

async function harness(rules: TimerRule[]) {
  const directory = await mkdtemp(join(tmpdir(), 'mq77-timer-'));
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

describe('waiting', () => {
  it('does nothing until the time is up, then acts', async () => {
    vi.useFakeTimers();
    try {
      const { mqtt } = await harness([timerRule()]);
      mqtt.deliver(LAMP.topic, { state: 'ON' });

      expect(mqtt.published).toEqual([]);
      await vi.advanceTimersByTimeAsync(31_000);

      expect(mqtt.published).toEqual([
        { topic: `${LAMP.topic}/set`, payload: '{"state":"OFF"}', retain: false },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says it has started, and says what it did', async () => {
    vi.useFakeTimers();
    try {
      const { engine, mqtt } = await harness([timerRule()]);
      mqtt.deliver(LAMP.topic, { state: 'ON' });
      expect(engine.getLog()[0]).toMatchObject({ ruleKind: 'timer', outcome: 'started' });

      await vi.advanceTimersByTimeAsync(31_000);
      expect(engine.getLog()[0]).toMatchObject({ outcome: 'fired' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('is called off when what started it stops being so', async () => {
    vi.useFakeTimers();
    try {
      const { engine, mqtt } = await harness([timerRule()]);
      mqtt.deliver(LAMP.topic, { state: 'ON' });

      // Switched off by hand, so the light is already where the timer was
      // going to put it and there is nothing left to do.
      mqtt.deliver(LAMP.topic, { state: 'OFF' });
      expect(engine.getLog()[0]).toMatchObject({ outcome: 'cancelled' });

      await vi.advanceTimersByTimeAsync(31_000);
      expect(mqtt.published).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts the count again when the same thing happens again', async () => {
    vi.useFakeTimers();
    try {
      const { mqtt } = await harness([timerRule()]);
      mqtt.deliver(LAMP.topic, { state: 'ON' });

      await vi.advanceTimersByTimeAsync(20_000);
      // Off and on again inside the wait: the clock starts over.
      mqtt.deliver(LAMP.topic, { state: 'OFF' });
      mqtt.deliver(LAMP.topic, { state: 'ON' });

      await vi.advanceTimersByTimeAsync(20_000);
      expect(mqtt.published).toEqual([]);

      await vi.advanceTimersByTimeAsync(11_000);
      expect(mqtt.published).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves a value that has not moved alone', async () => {
    vi.useFakeTimers();
    try {
      const { mqtt } = await harness([timerRule()]);
      mqtt.deliver(LAMP.topic, { state: 'ON' });

      // Zigbee2MQTT saying the light is still on is not it going off.
      mqtt.deliver(LAMP.topic, { state: 'ON', linkquality: 90 });
      await vi.advanceTimersByTimeAsync(31_000);

      expect(mqtt.published).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('acts on something other than what started it', async () => {
    vi.useFakeTimers();
    try {
      const rule = timerRule({
        actions: [{ sourceId: 'zigbee', deviceId: SOCKET.id, propertyKey: 'state', value: 'OFF' }],
      });
      const { mqtt } = await harness([rule]);
      mqtt.deliver(LAMP.topic, { state: 'ON' });
      await vi.advanceTimersByTimeAsync(31_000);

      expect(mqtt.published.at(-1)?.topic).toBe(`${SOCKET.topic}/set`);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing while switched off', async () => {
    vi.useFakeTimers();
    try {
      const { mqtt } = await harness([timerRule({ enabled: false })]);
      mqtt.deliver(LAMP.topic, { state: 'ON' });
      await vi.advanceTimersByTimeAsync(31_000);

      expect(mqtt.published).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgets what it was counting when it is stopped', async () => {
    vi.useFakeTimers();
    try {
      const { engine, mqtt } = await harness([timerRule()]);
      mqtt.deliver(LAMP.topic, { state: 'ON' });

      // What a Homebridge restart looks like from in here.
      engine.stop();
      await vi.advanceTimersByTimeAsync(31_000);

      expect(mqtt.published).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a timer watching a number', () => {
  const warm = timerRule({
    triggers: [
      {
        sourceId: 'zigbee',
        deviceId: LAMP.id,
        propertyKey: 'brightness',
        match: { kind: 'above', value: 200 },
      },
    ],
  });

  it('keeps counting while the reading stays over the line', async () => {
    vi.useFakeTimers();
    try {
      const { mqtt } = await harness([warm]);
      mqtt.deliver(LAMP.topic, { brightness: 220 });
      // Still over, so this is not a reason to stop.
      mqtt.deliver(LAMP.topic, { brightness: 230 });

      await vi.advanceTimersByTimeAsync(31_000);
      expect(mqtt.published).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops once the reading comes back under it', async () => {
    vi.useFakeTimers();
    try {
      const { mqtt } = await harness([warm]);
      mqtt.deliver(LAMP.topic, { brightness: 220 });
      mqtt.deliver(LAMP.topic, { brightness: 150 });

      await vi.advanceTimersByTimeAsync(31_000);
      expect(mqtt.published).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
