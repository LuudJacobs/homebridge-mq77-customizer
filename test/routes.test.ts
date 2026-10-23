import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Catalog } from '../src/catalog.js';
import { silentLogger } from '../src/logger.js';
import { RulesEngine } from '../src/rules/engine.js';
import type { AnyRule, Rule } from '../src/rules/types.js';
import { parseRule } from '../src/rules/validate.js';
import { Store, type Route } from '../src/store.js';
import fixture from './fixtures/bridge-devices.json' with { type: 'json' };
import safety from './fixtures/safety-devices.json' with { type: 'json' };
import { FakeMqtt } from './helpers/fake-mqtt.js';

const DOOR = { id: '0x00158dfffe0000a2', topic: 'zigbee2mqtt/front_door-contact' };
const FRONT = { id: '0x00158dfffe0000a6', topic: 'zigbee2mqtt/front_motion-aqara' };
const MOTION = { id: '0x00158dfffe0000a3', topic: 'zigbee2mqtt/hallway_motion-aqara' };
const LANDING = { id: '0x00158dfffe0000a5', topic: 'zigbee2mqtt/landing_motion-aqara' };
const PRESENCE = { id: '0x00158dfffe0000a4', topic: 'zigbee2mqtt/study_presence-aqara' };
const SOCKET = { id: '0x00158dfffe000006', topic: 'zigbee2mqtt/living_room_lamp-socket' };

/** More motion sensors, by the front door and on the landing, so a route can have four. */
const motion = safety.find((device) => device.ieee_address === MOTION.id)!;
const extra = [
  { ...motion, ieee_address: FRONT.id, friendly_name: 'front_motion-aqara' },
  { ...motion, ieee_address: LANDING.id, friendly_name: 'landing_motion-aqara' },
];

const sensor = (id: string) => ({ sourceId: 'zigbee', deviceId: id });

/** By the front door, the hallway, the landing and the study. */
const route = (over: Partial<Route> = {}): Route => ({
  id: 'route-1',
  name: 'Door to study',
  sensors: [sensor(FRONT.id), sensor(MOTION.id), sensor(LANDING.id), sensor(PRESENCE.id)],
  walkMs: 30_000,
  bothWays: true,
  ...over,
});

/** Turns the lamp on when the route is walked, either way unless told. */
const walkedRule = (over: Partial<Rule> = {}, direction?: 'forward' | 'back'): Rule => ({
  id: 'r1',
  name: 'Study light',
  enabled: true,
  triggers: [{ kind: 'route', routeId: 'route-1', ...(direction ? { direction } : {}) }],
  branches: [{ actions: [{ ...sensor(SOCKET.id), propertyKey: 'state', value: 'ON' }] }],
  rateLimitMs: 0,
  ...over,
});

async function harness(routes: Route[], rules: AnyRule[]) {
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
  mqtt.deliver('zigbee2mqtt/bridge/devices', [...fixture, ...safety, ...extra], { retained: true });
  const engine = new RulesEngine(catalog, store, mqtt.asConnection(), silentLogger);
  catalog.on('state', (update) => engine.handleState(update));
  return { mqtt, engine, store, catalog };
}

/** What a sensor says when it notices somebody, and when it stops. */
const reading = (topic: string, on: boolean) =>
  topic === DOOR.topic
    ? { contact: !on }
    : topic === PRESENCE.topic
      ? { presence: on }
      : { occupancy: on };

/** These noticing somebody, a second apart. */
const on = (mqtt: FakeMqtt, ...steps: { topic: string }[]) => {
  for (const step of steps) {
    mqtt.deliver(step.topic, reading(step.topic, true));
    vi.advanceTimersByTime(1000);
  }
};

/** These no longer noticing anybody. */
const off = (mqtt: FakeMqtt, ...steps: { topic: string }[]) => {
  for (const step of steps) {
    mqtt.deliver(step.topic, reading(step.topic, false));
  }
};

/**
 * Somebody walking past each of these in turn: each comes on as they reach
 * it, and the one before clears as they leave it. The last stays on.
 */
const walk = (mqtt: FakeMqtt, ...steps: { topic: string }[]) => {
  steps.forEach((step, index) => {
    on(mqtt, step);
    if (index > 0) {
      off(mqtt, steps[index - 1]!);
    }
  });
};

const lampOn = (mqtt: FakeMqtt) =>
  mqtt.published.filter((message) => message.topic === `${SOCKET.topic}/set`).length;

describe('walking a route', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is walked once the last sensor is occupied and the rest are clear', async () => {
    const { mqtt, engine } = await harness([route()], [walkedRule()]);
    walk(mqtt, FRONT, MOTION, LANDING, PRESENCE);
    expect(lampOn(mqtt)).toBe(1);
    expect(engine.getLog()[0]).toMatchObject({
      outcome: 'fired',
      walked: { routeId: 'route-1', routeName: 'Door to study', direction: 'forward' },
    });
  });

  it('waits for the sensor just left behind to clear', async () => {
    const { mqtt } = await harness([route()], [walkedRule()]);
    walk(mqtt, FRONT, MOTION, LANDING);
    on(mqtt, PRESENCE);
    expect(lampOn(mqtt)).toBe(0);

    off(mqtt, LANDING);
    expect(lampOn(mqtt)).toBe(1);
  });

  it('counts the walk from leaving the first sensor, however long somebody stood there', async () => {
    const { mqtt } = await harness([route()], [walkedRule()]);
    on(mqtt, FRONT);
    // A minute by the door, still occupied, before setting off.
    vi.advanceTimersByTime(60_000);
    walk(mqtt, FRONT, MOTION, LANDING, PRESENCE);
    expect(lampOn(mqtt)).toBe(1);
  });

  it('needs the first sensor still occupied when the next one notices somebody', async () => {
    const { mqtt } = await harness([route()], [walkedRule()]);
    on(mqtt, FRONT);
    off(mqtt, FRONT);
    walk(mqtt, MOTION, LANDING, PRESENCE);
    expect(lampOn(mqtt)).toBe(0);
  });

  it('is no walk when the last sensor clears first', async () => {
    const { mqtt } = await harness([route()], [walkedRule()]);
    walk(mqtt, FRONT, MOTION, LANDING);
    on(mqtt, PRESENCE);
    off(mqtt, PRESENCE, LANDING);
    expect(lampOn(mqtt)).toBe(0);
  });

  it('is no walk while somebody else is on the route', async () => {
    const { mqtt } = await harness([route({ bothWays: false })], [walkedRule()]);
    on(mqtt, LANDING);
    walk(mqtt, FRONT, MOTION, PRESENCE);
    expect(lampOn(mqtt)).toBe(0);
  });

  it('lets a sensor in between be missed, the second one too', async () => {
    const { mqtt } = await harness([route()], [walkedRule()]);
    walk(mqtt, FRONT, LANDING, PRESENCE);
    expect(lampOn(mqtt)).toBe(1);
  });

  it('calls the walk off when a sensor already passed notices somebody', async () => {
    const { mqtt } = await harness([route({ bothWays: false })], [walkedRule()]);
    walk(mqtt, FRONT, MOTION, LANDING, MOTION, PRESENCE);
    expect(lampOn(mqtt)).toBe(0);
  });

  it('sets out afresh from somebody coming back to the first sensor and leaving it again', async () => {
    const { mqtt } = await harness([route({ bothWays: false })], [walkedRule()]);
    walk(mqtt, FRONT, MOTION, FRONT, LANDING, PRESENCE);
    expect(lampOn(mqtt)).toBe(1);
  });

  it('is not walked when it takes longer than the route’s time', async () => {
    const { mqtt } = await harness([route({ walkMs: 5_000 })], [walkedRule()]);
    walk(mqtt, FRONT, MOTION);
    vi.advanceTimersByTime(6_000);
    walk(mqtt, MOTION, PRESENCE);
    expect(lampOn(mqtt)).toBe(0);
  });

  it('takes a sensor coming on, not one still saying it is on', async () => {
    const { mqtt } = await harness([route({ bothWays: false })], [walkedRule()]);
    walk(mqtt, FRONT, MOTION, LANDING);
    // The landing still occupied, said again with whatever else it reports.
    on(mqtt, LANDING);
    walk(mqtt, LANDING, PRESENCE);
    expect(lampOn(mqtt)).toBe(1);
  });

  it('does not take what the broker replays on connect for somebody noticed', async () => {
    const { mqtt } = await harness([route()], [walkedRule()]);
    on(mqtt, FRONT);
    mqtt.deliver(PRESENCE.topic, reading(PRESENCE.topic, true), { retained: true });
    off(mqtt, FRONT);
    expect(lampOn(mqtt)).toBe(0);
  });

  it('leaves a door out, since it never says nobody is there', async () => {
    const door = route({ sensors: [sensor(DOOR.id), sensor(MOTION.id), sensor(PRESENCE.id)] });
    const { mqtt } = await harness([door], [walkedRule()]);
    walk(mqtt, DOOR, MOTION, PRESENCE);
    expect(lampOn(mqtt)).toBe(0);
  });

  it('goes back the other way only on a route that goes both ways', async () => {
    const both = await harness([route()], [walkedRule()]);
    walk(both.mqtt, PRESENCE, LANDING, MOTION, FRONT);
    expect(lampOn(both.mqtt)).toBe(1);
    expect(both.engine.getLog()[0]).toMatchObject({ walked: { direction: 'back' } });

    const one = await harness([route({ bothWays: false })], [walkedRule()]);
    walk(one.mqtt, PRESENCE, LANDING, MOTION, FRONT);
    expect(lampOn(one.mqtt)).toBe(0);
  });

  it('takes a direction from the trigger, towards one end', async () => {
    const { mqtt } = await harness([route()], [walkedRule({}, 'back')]);
    walk(mqtt, FRONT, MOTION, PRESENCE);
    expect(lampOn(mqtt)).toBe(0);

    off(mqtt, PRESENCE);
    vi.advanceTimersByTime(60_000);
    walk(mqtt, PRESENCE, LANDING, FRONT);
    expect(lampOn(mqtt)).toBe(1);
  });

  it('waits when the rule says to, and nothing calls the wait off', async () => {
    const { mqtt, engine } = await harness([route()], [walkedRule({ waitMs: 10_000 })]);
    walk(mqtt, FRONT, MOTION, PRESENCE);
    expect(engine.getLog()[0]).toMatchObject({ outcome: 'waiting', walked: { routeId: 'route-1' } });

    off(mqtt, PRESENCE);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(lampOn(mqtt)).toBe(1);
    expect(engine.getLog()[0]).toMatchObject({ outcome: 'fired', walked: { routeId: 'route-1' } });
  });

  it('names the route in a notification', async () => {
    const sent: string[] = [];
    const directory = await mkdtemp(join(tmpdir(), 'mq77-routes-'));
    const store = new Store(join(directory, 'state.json'), silentLogger);
    await store.load();
    store.update((state) => {
      state.routes = [route()];
      state.rules = [
        walkedRule({ branches: [{ actions: [{ kind: 'notify', message: '<trigger> walked' }] }] }),
      ];
    });
    const mqtt = new FakeMqtt();
    const catalog = new Catalog(mqtt.asConnection(), silentLogger);
    await catalog.start([{ id: 'zigbee', adapter: 'zigbee2mqtt', baseTopic: 'zigbee2mqtt' }]);
    mqtt.deliver('zigbee2mqtt/bridge/devices', [...fixture, ...safety, ...extra], {
      retained: true,
    });
    const engine = new RulesEngine(catalog, store, mqtt.asConnection(), silentLogger, undefined, {
      send: async (_title, message) => {
        sent.push(message);
      },
    });
    catalog.on('state', (update) => engine.handleState(update));

    walk(mqtt, FRONT, PRESENCE);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(['Door to study walked']);
  });
});

describe('a route trigger, written down', () => {
  it('is kept with its route and direction', () => {
    const parsed = parseRule(walkedRule({}, 'back'), 'r1');
    expect('rule' in parsed && parsed.rule.triggers).toEqual([
      { kind: 'route', routeId: 'route-1', direction: 'back' },
    ]);
  });

  it('needs a route', () => {
    const parsed = parseRule({ ...walkedRule(), triggers: [{ kind: 'route' }] }, 'r1');
    expect(parsed).toEqual({ error: 'A route trigger needs a route' });
  });
});
