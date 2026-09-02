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

const LAMP = { id: '0x00158dfffe000003', topic: 'zigbee2mqtt/kitchen_dimmer-candeo' };
const SOCKET = { id: '0x00158dfffe000006', topic: 'zigbee2mqtt/living_room_lamp-socket' };

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

describe('a timer that acts on what it watches', () => {
  const anyChange = timerRule({
    triggers: [
      {
        sourceId: 'zigbee',
        deviceId: LAMP.id,
        propertyKey: 'state',
        match: { kind: 'changed' },
      },
    ],
  });

  it('does not start itself again on hearing its own doing', async () => {
    vi.useFakeTimers();
    try {
      const { mqtt } = await harness([anyChange]);
      mqtt.deliver(LAMP.topic, { state: 'ON' });
      await vi.advanceTimersByTimeAsync(31_000);

      // The light answers that it is off, which is a change, and used to be
      // read as a reason to start counting all over again.
      mqtt.deliver(LAMP.topic, { state: 'OFF' });
      await vi.advanceTimersByTimeAsync(60_000);

      expect(mqtt.published).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still starts on a change somebody made afterwards', async () => {
    vi.useFakeTimers();
    try {
      const { mqtt } = await harness([anyChange]);
      mqtt.deliver(LAMP.topic, { state: 'ON' });
      await vi.advanceTimersByTimeAsync(31_000);
      mqtt.deliver(LAMP.topic, { state: 'OFF' });

      // Long enough afterwards to be somebody rather than the device.
      await vi.advanceTimersByTimeAsync(5_000);
      mqtt.deliver(LAMP.topic, { state: 'ON' });
      await vi.advanceTimersByTimeAsync(31_000);

      expect(mqtt.published).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves another rule watching the same device alone', async () => {
    vi.useFakeTimers();
    try {
      const second = timerRule({
        id: 't2',
        name: 'Second',
        actions: [{ sourceId: 'zigbee', deviceId: SOCKET.id, propertyKey: 'state', value: 'OFF' }],
        triggers: [
          {
            sourceId: 'zigbee',
            deviceId: LAMP.id,
            propertyKey: 'state',
            match: { kind: 'changed' },
          },
        ],
      });
      const { mqtt } = await harness([anyChange, second]);

      mqtt.deliver(LAMP.topic, { state: 'ON' });
      await vi.advanceTimersByTimeAsync(31_000);
      // Both fired. Only the one that wrote the state disregards the answer.
      expect(mqtt.published).toHaveLength(2);

      mqtt.deliver(LAMP.topic, { state: 'OFF' });
      await vi.advanceTimersByTimeAsync(31_000);
      expect(mqtt.published).toHaveLength(3);
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

describe('a timer that asks a question first', () => {
  const gated = (holds: boolean) => ({
    ...timerRule(),
    when: {
      kind: 'all' as const,
      nodes: [
        {
          kind: 'test' as const,
          sourceId: 'zigbee',
          deviceId: SOCKET.id,
          propertyKey: 'state',
          match: { kind: 'equals' as const, value: holds ? 'ON' : 'OFF' },
        },
      ],
    },
  });

  it('does what it always did when the condition holds', async () => {
    vi.useFakeTimers();
    try {
      const { mqtt } = await harness([gated(true)]);
      // The socket has to have said something, or the condition is not false
      // so much as unanswerable.
      mqtt.deliver(SOCKET.topic, { state: 'ON' });
      mqtt.deliver(LAMP.topic, { state: 'ON' });
      mqtt.published.length = 0;

      await vi.advanceTimersByTimeAsync(31_000);
      expect(mqtt.published).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing when it does not, and says which condition turned it away', async () => {
    vi.useFakeTimers();
    try {
      const { engine, mqtt } = await harness([gated(false)]);
      mqtt.deliver(LAMP.topic, { state: 'ON' });
      mqtt.published.length = 0;

      await vi.advanceTimersByTimeAsync(31_000);

      expect(mqtt.published).toEqual([]);
      const last = engine.getLog()[0];
      expect(last).toMatchObject({ outcome: 'conditionsFailed' });
      expect(last?.detail).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still reads as called off when the trigger goes away, not as a condition failing', async () => {
    vi.useFakeTimers();
    try {
      const { engine, mqtt } = await harness([gated(true)]);
      mqtt.deliver(SOCKET.topic, { state: 'ON' });
      mqtt.deliver(LAMP.topic, { state: 'ON' });
      mqtt.deliver(LAMP.topic, { state: 'OFF' });

      await vi.advanceTimersByTimeAsync(31_000);
      expect(engine.getLog().some((entry) => entry.outcome === 'cancelled')).toBe(true);
      expect(engine.getLog().some((entry) => entry.outcome === 'conditionsFailed')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
