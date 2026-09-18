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

const LAMP = { id: '0x00158dfffe000003', topic: 'zigbee2mqtt/kitchen_dimmer-candeo' };
const SOCKET = { id: '0x00158dfffe000006', topic: 'zigbee2mqtt/living_room_lamp-socket' };
const SWITCH = { id: '0x00158dfffe000002', topic: 'zigbee2mqtt/living_room_switch-ZB2GS' };

const ref = (deviceId: string, propertyKey: string) => ({
  sourceId: 'zigbee',
  deviceId,
  propertyKey,
});

/** The socket coming on, half a minute later, switches the lamp on. */
function waiting(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 'r1',
    name: 'Light after a while',
    enabled: true,
    triggers: [{ ...ref(SOCKET.id, 'state'), match: { kind: 'changedTo', value: 'ON' } }],
    branches: [{ actions: [{ ...ref(LAMP.id, 'state'), value: 'ON' }] }],
    waitMs: 30_000,
    rateLimitMs: 0,
    ...overrides,
  } as Rule;
}

async function harness(rules: Rule[]) {
  const directory = await mkdtemp(join(tmpdir(), 'mq77-wait-'));
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

const sent = (mqtt: FakeMqtt) => mqtt.published.map((message) => message.payload);

describe('an automation that waits', () => {
  it('does nothing until the wait runs out, then acts', async () => {
    vi.useFakeTimers();
    try {
      const { mqtt } = await harness([waiting()]);
      mqtt.deliver(SOCKET.topic, { state: 'ON' });
      mqtt.published.length = 0;

      await vi.advanceTimersByTimeAsync(29_000);
      expect(sent(mqtt)).toEqual([]);

      await vi.advanceTimersByTimeAsync(2000);
      expect(sent(mqtt)).toEqual(['{"state":"ON"}']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('acts at once when there is no wait, as it always did', async () => {
    const { mqtt } = await harness([waiting({ waitMs: undefined })]);
    mqtt.deliver(SOCKET.topic, { state: 'ON' });
    expect(sent(mqtt)).toEqual(['{"state":"ON"}']);
  });

  it('says it is waiting, in minutes and seconds', async () => {
    vi.useFakeTimers();
    try {
      const { engine, mqtt } = await harness([waiting({ waitMs: 90_000 })]);
      mqtt.deliver(SOCKET.topic, { state: 'ON' });

      expect(engine.getLog()[0]).toMatchObject({ outcome: 'waiting', detail: '01:30' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks its conditions when the wait runs out, not when the trigger fired', async () => {
    vi.useFakeTimers();
    try {
      const rule = waiting({
        branches: [
          {
            when: {
              kind: 'test',
              ...ref(SWITCH.id, 'state_l2'),
              match: { kind: 'equals', value: 'ON' },
            },
            actions: [{ ...ref(LAMP.id, 'state'), value: 'ON' }],
          },
        ],
      });
      const { mqtt } = await harness([rule]);

      // False when the wait starts.
      mqtt.deliver(SWITCH.topic, { state_l2: 'OFF' });
      mqtt.deliver(SOCKET.topic, { state: 'ON' });
      mqtt.published.length = 0;

      // True by the time it runs out, which is the moment that counts.
      mqtt.deliver(SWITCH.topic, { state_l2: 'ON' });
      await vi.advanceTimersByTimeAsync(31_000);

      expect(sent(mqtt)).toEqual(['{"state":"ON"}']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is called off when what started it stops being true', async () => {
    vi.useFakeTimers();
    try {
      const { engine, mqtt } = await harness([waiting()]);
      mqtt.deliver(SOCKET.topic, { state: 'ON' });
      mqtt.deliver(SOCKET.topic, { state: 'OFF' });
      mqtt.published.length = 0;

      await vi.advanceTimersByTimeAsync(31_000);

      expect(sent(mqtt)).toEqual([]);
      expect(engine.getLog()[0]).toMatchObject({
        outcome: 'cancelled',
        // The value that took the wait away, not the one that started it.
        changed: { deviceId: SOCKET.id, propertyKey: 'state', value: 'OFF' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts the wait again when the same thing happens again', async () => {
    vi.useFakeTimers();
    try {
      const { engine, mqtt } = await harness([waiting()]);
      mqtt.deliver(SOCKET.topic, { state: 'ON' });

      await vi.advanceTimersByTimeAsync(20_000);
      // Off and on again inside the wait: the second ON starts a full one.
      mqtt.deliver(SOCKET.topic, { state: 'OFF' });
      mqtt.deliver(SOCKET.topic, { state: 'ON' });
      mqtt.published.length = 0;

      await vi.advanceTimersByTimeAsync(20_000);
      expect(sent(mqtt)).toEqual([]);

      await vi.advanceTimersByTimeAsync(11_000);
      expect(sent(mqtt)).toEqual(['{"state":"ON"}']);

      // Called off once, by the OFF, and never for starting over.
      const calls = engine.getLog().filter((entry) => entry.outcome === 'cancelled');
      expect(calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says it is waiting once, however often the same thing is reported', async () => {
    vi.useFakeTimers();
    try {
      // `equals` holds every time the value is read, not only when it moves,
      // and a device that reports twice would otherwise write two lines
      // saying the same thing.
      const twice = waiting({
        triggers: [{ ...ref(SOCKET.id, 'state'), match: { kind: 'equals', value: 'ON' } }],
      });
      const { engine, mqtt } = await harness([twice]);

      mqtt.deliver(SOCKET.topic, { state: 'ON' });
      mqtt.deliver(SOCKET.topic, { state: 'ON' });

      const lines = engine.getLog().filter((entry) => entry.outcome === 'waiting');
      expect(lines).toHaveLength(1);
      // And nothing about being called off either: it is the same wait.
      expect(engine.getLog().some((entry) => entry.outcome === 'cancelled')).toBe(false);

      // The clock still started again, so it acts from the second report.
      await vi.advanceTimersByTimeAsync(31_000);
      expect(sent(mqtt)).toEqual(['{"state":"ON"}']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands the wait to whichever trigger fired last, and calls the first off', async () => {
    vi.useFakeTimers();
    try {
      const rule = waiting({
        triggers: [
          { ...ref(SOCKET.id, 'state'), match: { kind: 'changedTo', value: 'ON' } },
          { ...ref(SWITCH.id, 'state_l1'), match: { kind: 'changedTo', value: 'ON' } },
        ],
      });
      const { engine, mqtt } = await harness([rule]);

      mqtt.deliver(SOCKET.topic, { state: 'ON' });
      await vi.advanceTimersByTimeAsync(20_000);
      mqtt.deliver(SWITCH.topic, { state_l1: 'ON' });
      mqtt.published.length = 0;

      // The first one is off the clock, whatever is left of its wait.
      expect(engine.getLog().some((entry) => entry.outcome === 'cancelled')).toBe(true);
      await vi.advanceTimersByTimeAsync(11_000);
      expect(sent(mqtt)).toEqual([]);

      // And the second runs its own full wait from where it started.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(sent(mqtt)).toEqual(['{"state":"ON"}']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing while it is switched off', async () => {
    vi.useFakeTimers();
    try {
      const { mqtt } = await harness([waiting({ enabled: false })]);
      mqtt.deliver(SOCKET.topic, { state: 'ON' });
      await vi.advanceTimersByTimeAsync(31_000);
      expect(sent(mqtt)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgets what it was counting when the engine stops', async () => {
    vi.useFakeTimers();
    try {
      const { engine, mqtt } = await harness([waiting()]);
      mqtt.deliver(SOCKET.topic, { state: 'ON' });
      mqtt.published.length = 0;

      engine.stop();
      await vi.advanceTimersByTimeAsync(31_000);

      expect(sent(mqtt)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('acts at once when the rule is run by hand', async () => {
    const { engine, mqtt } = await harness([waiting()]);
    mqtt.deliver(SOCKET.topic, { state: 'ON' });
    mqtt.published.length = 0;

    // Trying a rule while building it is not sitting through its wait.
    engine.runNow('r1');
    expect(sent(mqtt)).toEqual(['{"state":"ON"}']);
  });

  it('counts a firing when it acts, not when the trigger fired', async () => {
    vi.useFakeTimers();
    try {
      const { engine, mqtt } = await harness([waiting({ rateLimitMs: 60_000 })]);

      mqtt.deliver(SOCKET.topic, { state: 'ON' });
      await vi.advanceTimersByTimeAsync(31_000);
      expect(sent(mqtt)).toEqual(['{"state":"ON"}']);

      // Within the limit of the firing, so the second wait is turned away at
      // the end rather than never started.
      mqtt.published.length = 0;
      mqtt.deliver(SOCKET.topic, { state: 'OFF' });
      mqtt.deliver(SOCKET.topic, { state: 'ON' });
      expect(engine.getLog()[0]).toMatchObject({ outcome: 'waiting' });

      await vi.advanceTimersByTimeAsync(31_000);
      expect(sent(mqtt)).toEqual([]);
      expect(engine.getLog()[0]).toMatchObject({ outcome: 'rateLimited' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps waiting while a reading stays over the line, and stops when it drops', async () => {
    vi.useFakeTimers();
    try {
      const warm = waiting({
        triggers: [{ ...ref(LAMP.id, 'brightness'), match: { kind: 'above', value: 200 } }],
        branches: [{ actions: [{ ...ref(SOCKET.id, 'state'), value: 'OFF' }] }],
      });
      const { mqtt } = await harness([warm]);

      mqtt.deliver(LAMP.topic, { brightness: 220 });
      // Still over, so this is not a reason to stop.
      mqtt.deliver(LAMP.topic, { brightness: 230 });
      await vi.advanceTimersByTimeAsync(31_000);
      expect(sent(mqtt)).toHaveLength(1);

      mqtt.published.length = 0;
      mqtt.deliver(LAMP.topic, { brightness: 220 });
      mqtt.deliver(LAMP.topic, { brightness: 150 });
      await vi.advanceTimersByTimeAsync(31_000);
      expect(sent(mqtt)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits out a time trigger too, which nothing can call off', async () => {
    vi.useFakeTimers();
    try {
      const rule = waiting({ triggers: [{ kind: 'time', at: '22:00' }] });
      const { engine, mqtt } = await harness([rule]);

      vi.setSystemTime(new Date('2026-03-10T22:00:05'));
      engine.readClock(new Date());
      mqtt.published.length = 0;
      expect(engine.getLog()[0]).toMatchObject({ outcome: 'waiting' });

      await vi.advanceTimersByTimeAsync(31_000);

      expect(sent(mqtt)).toEqual(['{"state":"ON"}']);
      // And the line still says which time set it off.
      expect(engine.getLog()[0]).toMatchObject({ outcome: 'fired', firedAt: { at: '22:00' } });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a rule that waits and acts on what it watches', () => {
  /** On any change of the lamp, thirty seconds later, switch it off. */
  const anyChange = waiting({
    triggers: [{ ...ref(LAMP.id, 'state'), match: { kind: 'changed' } }],
    branches: [{ actions: [{ ...ref(LAMP.id, 'state'), value: 'OFF' }] }],
  });

  it('does not start itself again on hearing its own doing', async () => {
    vi.useFakeTimers();
    try {
      const { mqtt } = await harness([anyChange]);
      mqtt.deliver(LAMP.topic, { state: 'ON' });
      await vi.advanceTimersByTimeAsync(31_000);

      // The light answers that it is off, which is a change, and would
      // otherwise be read as a reason to start waiting all over again.
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
      await vi.advanceTimersByTimeAsync(5000);
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
      const second = waiting({
        id: 'r2',
        name: 'Second',
        triggers: [{ ...ref(LAMP.id, 'state'), match: { kind: 'changed' } }],
        branches: [{ actions: [{ ...ref(SOCKET.id, 'state'), value: 'OFF' }] }],
      });
      const { mqtt } = await harness([anyChange, second]);

      mqtt.deliver(LAMP.topic, { state: 'ON' });
      await vi.advanceTimersByTimeAsync(31_000);
      // Both acted. Only the one that wrote the state disregards the answer.
      expect(mqtt.published).toHaveLength(2);

      mqtt.deliver(LAMP.topic, { state: 'OFF' });
      await vi.advanceTimersByTimeAsync(31_000);
      expect(mqtt.published).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
