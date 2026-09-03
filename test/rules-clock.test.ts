import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { Catalog } from '../src/catalog.js';
import { silentLogger } from '../src/logger.js';
import { onSide } from '../src/rules/clock.js';
import { RulesEngine } from '../src/rules/engine.js';
import type { Rule, TimeCondition } from '../src/rules/types.js';
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

/** Amsterdam, which is where the suite's clock is set as well. */
const HOUSE = { latitude: 52.37, longitude: 4.9 };

async function harness(rules: Rule[], place?: { latitude: number; longitude: number }) {
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

  const engine = new RulesEngine(catalog, store, mqtt.asConnection(), silentLogger, place);
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
    expect(engine.getLog()[0]).toMatchObject({ outcome: 'fired', firedAt: { at: '22:00' } });
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
  const before = (at: string, offset?: number): TimeCondition => ({
    kind: 'time',
    side: 'before',
    at,
    ...(offset === undefined ? {} : { offset }),
  });
  const after = (at: string, offset?: number): TimeCondition => ({
    ...before(at, offset),
    side: 'after',
  });

  it('holds up to and including the minute it names, and not past it', () => {
    expect(onSide(before('04:00'), at('2026-03-10T00:00:00'))).toBe(true);
    expect(onSide(before('04:00'), at('2026-03-10T03:59:00'))).toBe(true);
    // The minute it names counts: a rule set for four holds at four.
    expect(onSide(before('04:00'), at('2026-03-10T04:00:30'))).toBe(true);
    expect(onSide(before('04:00'), at('2026-03-10T04:01:00'))).toBe(false);
  });

  it('holds from the minute it names to the end of the day, the other way round', () => {
    expect(onSide(after('22:00'), at('2026-03-10T21:59:00'))).toBe(false);
    expect(onSide(after('22:00'), at('2026-03-10T22:00:10'))).toBe(true);
    expect(onSide(after('22:00'), at('2026-03-10T23:59:00'))).toBe(true);
  });

  it('makes a night out of the two of them, which is what an any group is for', async () => {
    // After 22:00 or before 06:00: the two sides of midnight, in one group.
    const night = { kind: 'any' as const, nodes: [after('22:00'), before('06:00')] };
    const { engine, mqtt } = await harness([
      rule({ triggers: [{ kind: 'time', at: '23:00' }], when: night }),
    ]);

    strike(engine, '2026-03-10T23:00:05');
    expect(sent(mqtt)).toEqual(['{"state":"ON"}']);
  });

  it('turns a rule away when the clock is on the other side, and says which', async () => {
    const { engine, mqtt } = await harness([
      rule({
        triggers: [{ kind: 'time', at: '22:00' }],
        when: { kind: 'all', nodes: [before('09:00')] },
      }),
    ]);

    strike(engine, '2026-03-10T22:00:05');

    expect(sent(mqtt)).toEqual([]);
    expect(engine.getLog()[0]).toMatchObject({ outcome: 'conditionsFailed' });
    expect(engine.getLog()[0]?.detail).toContain('not before 09:00');
  });
});

describe('the times the sun decides', () => {
  // 2026-09-02 in Amsterdam: sunrise 06:53, sunset 20:26, dusk 21:01.
  const sunRule = (at: string, offset?: number) =>
    rule({ triggers: [{ kind: 'time', at, ...(offset === undefined ? {} : { offset }) }] });

  it('fires at the minute the sun reaches it', async () => {
    const { engine, mqtt } = await harness([sunRule('sunset')], HOUSE);

    strike(engine, '2026-09-02T20:25:30');
    expect(sent(mqtt)).toEqual([]);

    strike(engine, '2026-09-02T20:26:10');
    expect(sent(mqtt)).toEqual(['{"state":"ON"}']);
  });

  it('takes an offset either side', async () => {
    const { engine, mqtt } = await harness([sunRule('sunset', -30)], HOUSE);

    strike(engine, '2026-09-02T20:26:10');
    expect(sent(mqtt)).toEqual([]);

    strike(engine, '2026-09-02T19:56:10');
    expect(sent(mqtt)).toEqual(['{"state":"ON"}']);
  });

  it('reads dusk as later than sunset, since that is the point of it', async () => {
    const { engine, mqtt } = await harness([sunRule('dusk')], HOUSE);

    strike(engine, '2026-09-02T20:26:10');
    expect(sent(mqtt)).toEqual([]);

    strike(engine, '2026-09-02T21:01:30');
    expect(sent(mqtt)).toEqual(['{"state":"ON"}']);
  });

  it('says so, once a day, when there is no location to work it out from', async () => {
    const { engine, mqtt } = await harness([sunRule('sunset')]);

    strike(engine, '2026-09-02T20:26:10');
    strike(engine, '2026-09-02T20:27:10');

    expect(sent(mqtt)).toEqual([]);
    const complaints = engine.getLog().filter((entry) => entry.outcome === 'failed');
    expect(complaints).toHaveLength(1);
    expect(complaints[0]?.detail).toContain('location');
  });

  it('leaves a clock time alone when there is no location', async () => {
    const { engine, mqtt } = await harness([rule()]);

    strike(engine, '2026-03-10T22:00:05');
    expect(sent(mqtt)).toEqual(['{"state":"ON"}']);
  });

  it('says the location is missing, rather than which side of dusk it was', async () => {
    const { engine, mqtt } = await harness([
      rule({
        triggers: [{ kind: 'time', at: '22:00' }],
        when: { kind: 'all', nodes: [{ kind: 'time', side: 'after', at: 'dusk' }] },
      }),
    ]);

    strike(engine, '2026-09-02T22:00:05');

    expect(sent(mqtt)).toEqual([]);
    expect(engine.getLog()[0]?.detail).toContain('needs a location');
    expect(engine.getLog()[0]?.detail).not.toContain('not after');
    // A failure rather than a refusal, so the log says it out loud: an
    // ordinary `conditions not met` line does not carry its reason.
    expect(engine.getLog()[0]?.outcome).toBe('failed');
  });

  it('holds a condition whose time the sun decides', async () => {
    const afterDusk: TimeCondition = { kind: 'time', side: 'after', at: 'dusk' };
    // Dusk is 21:01 on this date in Amsterdam.
    expect(onSide(afterDusk, at('2026-09-02T23:00:00'), HOUSE)).toBe(true);
    expect(onSide(afterDusk, at('2026-09-02T12:00:00'), HOUSE)).toBe(false);
    // With nowhere to work it out from, it holds at no time at all.
    expect(onSide(afterDusk, at('2026-09-02T23:00:00'))).toBe(false);
  });
});
