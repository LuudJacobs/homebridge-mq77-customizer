import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Catalog } from '../src/catalog.js';
import { silentLogger } from '../src/logger.js';
import { RulesEngine } from '../src/rules/engine.js';
import type { AnyRule, RouteCondition } from '../src/rules/types.js';
import { parseRule } from '../src/rules/validate.js';
import { RouteTracker } from '../src/routes.js';
import { Store, type Route } from '../src/store.js';
import fixture from './fixtures/bridge-devices.json' with { type: 'json' };
import safety from './fixtures/safety-devices.json' with { type: 'json' };
import { FakeMqtt } from './helpers/fake-mqtt.js';

const DOOR = { id: '0x00158dfffe0000a2', topic: 'zigbee2mqtt/front_door-contact' };
const MOTION = { id: '0x00158dfffe0000a3', topic: 'zigbee2mqtt/hallway_motion-aqara' };
const PRESENCE = { id: '0x00158dfffe0000a4', topic: 'zigbee2mqtt/study_presence-aqara' };
const SOCKET = { id: '0x00158dfffe000006', topic: 'zigbee2mqtt/living_room_lamp-socket' };

const sensor = (id: string) => ({ sourceId: 'zigbee', deviceId: id });

/** Front door, then the hallway, then the study. */
const route = (over: Partial<Route> = {}): Route => ({
  id: 'route-1',
  name: 'Door to study',
  sensors: [sensor(DOOR.id), sensor(MOTION.id), sensor(PRESENCE.id)],
  gapMs: 10_000,
  bothWays: true,
  ...over,
});

async function harness(routes: Route[], rules: AnyRule[] = []) {
  const directory = await mkdtemp(join(tmpdir(), 'mq77-routes-'));
  const store = new Store(join(directory, 'state.json'), silentLogger);
  await store.load();
  store.update((state) => {
    state.routes = routes;
    state.rules = rules;
  });
  const mqtt = new FakeMqtt();
  const catalog = new Catalog(mqtt.asConnection(), silentLogger);
  await catalog.start([{ id: 'zigbee', adapter: 'zigbee2mqtt', baseTopic: 'zigbee2mqtt' }]);
  mqtt.deliver('zigbee2mqtt/bridge/devices', [...fixture, ...safety], { retained: true });
  const tracker = new RouteTracker(store, catalog);
  catalog.on('state', (update) => tracker.handleState(update));
  return { mqtt, tracker, store, catalog };
}

/** Somebody noticed by each of these, a second apart. */
const walk = (mqtt: FakeMqtt, ...steps: { topic: string }[]) => {
  for (const step of steps) {
    const payload =
      step.topic === DOOR.topic
        ? { contact: false }
        : step.topic === MOTION.topic
          ? { occupancy: true }
          : { presence: true };
    mqtt.deliver(step.topic, payload);
    vi.advanceTimersByTime(1000);
  }
};

describe('following somebody along a route', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('puts them on it from the second sensor in order, not the first', async () => {
    const { mqtt, tracker } = await harness([route()]);
    walk(mqtt, DOOR);
    expect(tracker.position('route-1')).toBeUndefined();

    walk(mqtt, MOTION);
    expect(tracker.position('route-1')).toEqual({ at: sensor(MOTION.id), direction: 'forward' });

    walk(mqtt, PRESENCE);
    expect(tracker.position('route-1')).toEqual({ at: sensor(PRESENCE.id), direction: 'forward' });
  });

  it('follows them back the other way, when the route goes both ways', async () => {
    const both = await harness([route()]);
    walk(both.mqtt, PRESENCE, MOTION);
    expect(both.tracker.position('route-1')).toEqual({ at: sensor(MOTION.id), direction: 'back' });

    const one = await harness([route({ bothWays: false })]);
    walk(one.mqtt, PRESENCE, MOTION);
    expect(one.tracker.position('route-1')).toBeUndefined();
  });

  it('loses them once the gap between two sensors runs out, the last one too', async () => {
    const { mqtt, tracker } = await harness([route()]);
    walk(mqtt, DOOR, MOTION, PRESENCE);
    vi.advanceTimersByTime(8_000);
    expect(tracker.position('route-1')).toBeDefined();
    vi.advanceTimersByTime(2_000);
    expect(tracker.position('route-1')).toBeUndefined();

    // Too slow to start one either.
    mqtt.deliver(DOOR.topic, { contact: false });
    vi.advanceTimersByTime(11_000);
    mqtt.deliver(MOTION.topic, { occupancy: true });
    expect(tracker.position('route-1')).toBeUndefined();
  });

  it('counts a door opening, not a door closing, and nothing replayed on connect', async () => {
    const { mqtt, tracker } = await harness([route()]);
    mqtt.deliver(DOOR.topic, { contact: true });
    vi.advanceTimersByTime(1000);
    mqtt.deliver(MOTION.topic, { occupancy: true });
    expect(tracker.position('route-1')).toBeUndefined();

    mqtt.deliver(DOOR.topic, { contact: false }, { retained: true });
    vi.advanceTimersByTime(1000);
    mqtt.deliver(MOTION.topic, { occupancy: true });
    expect(tracker.position('route-1')).toBeUndefined();
  });
});

describe('asking about a route in a rule', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const rule = (when: RouteCondition): AnyRule =>
    ({
      id: 'r1',
      name: 'Licht',
      enabled: true,
      rateLimitMs: 0,
      // Set off by the study's own sensor, after the route has heard it.
      triggers: [{ ...sensor(PRESENCE.id), propertyKey: 'presence', match: { kind: 'changed' } }],
      branches: [{ when, actions: [{ ...sensor(SOCKET.id), propertyKey: 'state', value: 'ON' }] }],
    }) as AnyRule;

  async function run(when: RouteCondition, ...steps: { topic: string }[]) {
    const directory = await mkdtemp(join(tmpdir(), 'mq77-route-rules-'));
    const store = new Store(join(directory, 'state.json'), silentLogger);
    await store.load();
    store.update((state) => {
      state.routes = [route()];
      state.rules = [rule(when)];
    });
    const mqtt = new FakeMqtt();
    const catalog = new Catalog(mqtt.asConnection(), silentLogger);
    await catalog.start([{ id: 'zigbee', adapter: 'zigbee2mqtt', baseTopic: 'zigbee2mqtt' }]);
    mqtt.deliver('zigbee2mqtt/bridge/devices', [...fixture, ...safety], { retained: true });
    const engine = new RulesEngine(catalog, store, mqtt.asConnection(), silentLogger);
    catalog.on('state', (update) => engine.handleState(update));
    walk(mqtt, ...steps);
    engine.stop();
    return { sent: mqtt.published.length > 0, engine };
  }

  const on = (test: RouteCondition['test'], extra: Partial<RouteCondition> = {}) =>
    ({ kind: 'route', routeId: 'route-1', test, ...extra }) as RouteCondition;

  it('runs while somebody is on it, and not otherwise', async () => {
    expect((await run(on('on'), DOOR, MOTION, PRESENCE)).sent).toBe(true);
    expect((await run(on('on'), PRESENCE)).sent).toBe(false);
    expect((await run(on('off'), PRESENCE)).sent).toBe(true);
  });

  it('asks which sensor they are at, and which way they are going', async () => {
    expect((await run(on('at', { sensor: sensor(PRESENCE.id) }), MOTION, PRESENCE)).sent).toBe(true);
    expect((await run(on('at', { sensor: sensor(MOTION.id) }), MOTION, PRESENCE)).sent).toBe(false);
    expect((await run(on('towards', { direction: 'forward' }), MOTION, PRESENCE)).sent).toBe(true);
    expect((await run(on('towards', { direction: 'back' }), MOTION, PRESENCE)).sent).toBe(false);
  });

  it('says so when the route asked about is gone', async () => {
    const { engine } = await run({ kind: 'route', routeId: 'gone', test: 'on' }, MOTION, PRESENCE);
    expect(engine.getLog()[0]).toMatchObject({ outcome: 'failed', detail: 'that route is not there any more' });
  });

  it('is read back from a saved rule', () => {
    const parsed = parseRule(
      {
        name: 'Licht',
        trigger: { ...sensor('0xa'), propertyKey: 'state', match: { kind: 'changed' } },
        when: { kind: 'route', routeId: 'route-1', test: 'at', sensor: sensor('0xb') },
        actions: [{ ...sensor('0xc'), propertyKey: 'state', value: 'ON' }],
      },
      'r1',
    );
    expect('rule' in parsed && parsed.rule.branches?.[0]?.when).toEqual({
      kind: 'route',
      routeId: 'route-1',
      test: 'at',
      sensor: sensor('0xb'),
    });
  });
});
