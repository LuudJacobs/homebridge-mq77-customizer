import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { Catalog } from '../src/catalog.js';
import { silentLogger } from '../src/logger.js';
import { inWindow } from '../src/rules/clock.js';
import { RulesEngine } from '../src/rules/engine.js';
import type { Rule, TimeWindow } from '../src/rules/types.js';
import { Store } from '../src/store.js';
import fixture from './fixtures/bridge-devices.json' with { type: 'json' };
import { FakeMqtt } from './helpers/fake-mqtt.js';

/** The Candeo dimmer, which is what these rules switch. */
const LAMP = { id: '0x00158dfffe000003', topic: 'zigbee2mqtt/kitchen_dimmer-candeo' };

const rule = (overrides: Partial<Rule> = {}): Rule => ({
  id: 'r1',
  kind: 'standard',
  name: 'Evening',
  enabled: true,
  triggers: [{ kind: 'time', at: '22:00' }],
  actions: [{ sourceId: 'zigbee', deviceId: LAMP.id, propertyKey: 'state', value: 'ON' }],
  ...overrides,
});

async function harness(rules: Rule[]) {
  const directory = await mkdtemp(join(tmpdir(), 'mq77-clock-'));
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
  return { engine, mqtt, store };
}

/** Local time, which is the only time a rule is written in. */
const at = (text: string) => new Date(text);

/**
 * Moves the whole clock, not just the one the engine is handed.
 *
 * The rate limit and a time condition both read the real clock, so a test
 * that only pretended about the minute would have the engine believing two
 * different times at once.
 */
function strike(engine: RulesEngine, text: string): void {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(at(text));
    engine.readClock(new Date());
  } finally {
    vi.useRealTimers();
  }
}

const sent = (mqtt: FakeMqtt) => mqtt.published.map((message) => message.payload);

describe('a time as a trigger', () => {
  it('fires when the clock reaches the minute, and once within it', async () => {
    const { engine, mqtt } = await harness([rule()]);

    strike(engine, '2026-03-10T21:59:40');
    expect(sent(mqtt)).toEqual([]);

    strike(engine, '2026-03-10T22:00:05');
    expect(sent(mqtt)).toEqual(['{"state":"ON"}']);

    // Still the same minute, so it has already happened.
    strike(engine, '2026-03-10T22:00:50');
    expect(sent(mqtt)).toEqual(['{"state":"ON"}']);
  });

  it('fires again the next day, and not in between', async () => {
    const { engine, mqtt } = await harness([rule()]);

    strike(engine, '2026-03-10T22:00:05');
    strike(engine, '2026-03-11T09:00:00');
    expect(sent(mqtt)).toHaveLength(1);

    strike(engine, '2026-03-11T22:00:10');
    expect(sent(mqtt)).toHaveLength(2);
  });

  it('keeps to the days it was given', async () => {
    // 2026-03-10 is a Tuesday, 2026-03-14 a Saturday.
    const { engine, mqtt } = await harness([
      rule({ triggers: [{ kind: 'time', at: '22:00', days: ['sat', 'sun'] }] }),
    ]);

    strike(engine, '2026-03-10T22:00:05');
    expect(sent(mqtt)).toEqual([]);

    strike(engine, '2026-03-14T22:00:05');
    expect(sent(mqtt)).toEqual(['{"state":"ON"}']);
  });

  it('says in the log what time set it off', async () => {
    const { engine } = await harness([rule()]);

    strike(engine, '2026-03-10T22:00:05');
    expect(engine.getLog()[0]).toMatchObject({ outcome: 'fired', firedAt: '22:00' });
  });

  it('makes up nothing for a minute that passed while it was not running', async () => {
    const { engine, mqtt } = await harness([rule()]);

    // The plugin comes up at twenty past, having missed ten o'clock entirely.
    strike(engine, '2026-03-10T22:20:00');
    expect(sent(mqtt)).toEqual([]);
  });

  it('leaves a disabled rule alone', async () => {
    const { engine, mqtt } = await harness([rule({ enabled: false })]);

    strike(engine, '2026-03-10T22:00:05');
    expect(sent(mqtt)).toEqual([]);
  });
});

describe('the two days the clock is not a straight line', () => {
  // Amsterdam went forward at 02:00 on 2026-03-29 and back at 03:00 on
  // 2026-10-25. The engine only ever asks what the local time is now, so both
  // days fall out of that rather than needing a rule of their own.

  it('does not fire for a time the day skips', async () => {
    const { engine, mqtt } = await harness([rule({ triggers: [{ kind: 'time', at: '02:30' }] })]);

    // The clock jumps from 01:59 to 03:00, so 02:30 never arrives.
    strike(engine, '2026-03-29T01:59:50');
    strike(engine, '2026-03-29T03:00:10');
    strike(engine, '2026-03-29T03:30:10');

    expect(sent(mqtt)).toEqual([]);
  });

  it('fires once for a time the day has twice', async () => {
    const { engine, mqtt } = await harness([rule({ triggers: [{ kind: 'time', at: '02:30' }] })]);

    // 02:30 comes round, the clock goes back at 03:00, and 02:30 comes again
    // an hour of real time later. Both are 02:30 in Amsterdam, which is the
    // zone the suite is pinned to.
    const first = at('2026-10-25T02:30:05');
    const second = new Date(first.getTime() + 60 * 60 * 1000);
    expect(second.getHours()).toBe(2);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(first);
      engine.readClock(new Date());
      vi.setSystemTime(second);
      engine.readClock(new Date());
    } finally {
      vi.useRealTimers();
    }

    // One minute, so one firing, however many times the clock passes through it.
    expect(sent(mqtt)).toHaveLength(1);
  });
});

describe('a time as a condition', () => {
  const window = (over: Partial<TimeWindow> = {}): TimeWindow => ({
    kind: 'time',
    from: '22:00',
    to: '06:00',
    ...over,
  });

  it('holds through the night when the window crosses midnight', () => {
    expect(inWindow(window(), at('2026-03-10T23:00:00'))).toBe(true);
    expect(inWindow(window(), at('2026-03-11T02:00:00'))).toBe(true);
    expect(inWindow(window(), at('2026-03-11T12:00:00'))).toBe(false);
    expect(inWindow(window(), at('2026-03-11T21:59:00'))).toBe(false);
  });

  it('holds inside a plain window and not outside it', () => {
    const day = window({ from: '09:00', to: '17:00' });
    expect(inWindow(day, at('2026-03-10T08:59:00'))).toBe(false);
    expect(inWindow(day, at('2026-03-10T09:00:00'))).toBe(true);
    expect(inWindow(day, at('2026-03-10T16:59:00'))).toBe(true);
    // The far end is the moment it closes, so it is already shut.
    expect(inWindow(day, at('2026-03-10T17:00:00'))).toBe(false);
  });

  it('reads equal ends as the whole day rather than as an instant', () => {
    const always = window({ from: '12:00', to: '12:00' });
    expect(inWindow(always, at('2026-03-10T03:00:00'))).toBe(true);
    expect(inWindow(always, at('2026-03-10T12:00:00'))).toBe(true);
  });

  it('reads the days of a night window from the evening it started', () => {
    // Friday night, which is Friday evening and the small hours of Saturday.
    const friday = window({ days: ['fri'] });
    expect(inWindow(friday, at('2026-03-13T23:00:00'))).toBe(true);
    expect(inWindow(friday, at('2026-03-14T02:00:00'))).toBe(true);
    // Saturday evening belongs to Saturday, which was not asked for.
    expect(inWindow(friday, at('2026-03-14T23:00:00'))).toBe(false);
  });

  it('turns a rule away when the clock is outside the window, and says so', async () => {
    const { engine, mqtt } = await harness([
      rule({
        triggers: [{ kind: 'time', at: '22:00' }],
        when: { kind: 'all', nodes: [window({ from: '09:00', to: '17:00' })] },
      }),
    ]);

    strike(engine, '2026-03-10T22:00:05');

    expect(sent(mqtt)).toEqual([]);
    expect(engine.getLog()[0]).toMatchObject({ outcome: 'conditionsFailed' });
    expect(engine.getLog()[0]?.detail).toContain('09:00');
  });
});
