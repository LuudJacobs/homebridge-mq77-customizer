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
const MOTION = { id: '0x00158dfffe0000a3', topic: 'zigbee2mqtt/hallway_motion-aqara' };
const LANDING = { id: '0x00158dfffe0000a5', topic: 'zigbee2mqtt/landing_motion-aqara' };
const PRESENCE = { id: '0x00158dfffe0000a4', topic: 'zigbee2mqtt/study_presence-aqara' };
const SOCKET = { id: '0x00158dfffe000006', topic: 'zigbee2mqtt/living_room_lamp-socket' };

/** A second motion sensor, on the landing, so a route can have four. */
const landing = {
  ...safety.find((device) => device.ieee_address === MOTION.id)!,
  ieee_address: LANDING.id,
  friendly_name: 'landing_motion-aqara',
};

const sensor = (id: string) => ({ sourceId: 'zigbee', deviceId: id });

/** The front door, the hallway, the landing and the study. */
const route = (over: Partial<Route> = {}): Route => ({
  id: 'route-1',
  name: 'Door to study',
  sensors: [sensor(DOOR.id), sensor(MOTION.id), sensor(LANDING.id), sensor(PRESENCE.id)],
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
  mqtt.deliver('zigbee2mqtt/bridge/devices', [...fixture, ...safety, landing], { retained: true });
  const engine = new RulesEngine(catalog, store, mqtt.asConnection(), silentLogger);
  catalog.on('state', (update) => engine.handleState(update));
  return { mqtt, engine, store };
}

/** What a sensor says when it notices somebody, and when it stops. */
const reading = (topic: string, on: boolean) =>
  topic === DOOR.topic
    ? { contact: !on }
    : topic === PRESENCE.topic
      ? { presence: on }
      : { occupancy: on };

/** Somebody noticed by each of these, a second apart. */
const walk = (mqtt: FakeMqtt, ...steps: { topic: string }[]) => {
  for (const step of steps) {
    mqtt.deliver(step.topic, reading(step.topic, true));
    vi.advanceTimersByTime(1000);
  }
};

/** These no longer noticing anybody. */
const clear = (mqtt: FakeMqtt, ...steps: { topic: string }[]) => {
  for (const step of steps) {
    mqtt.deliver(step.topic, reading(step.topic, false));
  }
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

  it('sets a rule off at the last sensor, and not before', async () => {
    const { mqtt, engine } = await harness([route()], [walkedRule()]);
    walk(mqtt, DOOR, MOTION, LANDING);
    expect(lampOn(mqtt)).toBe(0);

    walk(mqtt, PRESENCE);
    expect(lampOn(mqtt)).toBe(1);
    expect(engine.getLog()[0]).toMatchObject({
      outcome: 'fired',
      walked: { routeId: 'route-1', routeName: 'Door to study', direction: 'forward' },
    });
  });

  it('lets a sensor in between be missed', async () => {
    const { mqtt } = await harness([route()], [walkedRule()]);
    walk(mqtt, DOOR, LANDING, PRESENCE);
    expect(lampOn(mqtt)).toBe(1);
  });

  it('needs the first sensor to start from', async () => {
    const { mqtt } = await harness([route()], [walkedRule()]);
    walk(mqtt, MOTION, LANDING, PRESENCE);
    expect(lampOn(mqtt)).toBe(0);
  });

  it('calls the walk off when a sensor already passed notices somebody', async () => {
    const { mqtt } = await harness([route({ bothWays: false })], [walkedRule()]);
    walk(mqtt, DOOR, MOTION);
    clear(mqtt, MOTION);
    walk(mqtt, LANDING, MOTION, PRESENCE);
    expect(lampOn(mqtt)).toBe(0);
  });

  it('starts again from the first sensor noticing somebody', async () => {
    const { mqtt } = await harness([route({ bothWays: false })], [walkedRule()]);
    walk(mqtt, DOOR, MOTION);
    clear(mqtt, DOOR);
    vi.advanceTimersByTime(25_000);
    // Thirty seconds from the first door would have run out by the study.
    walk(mqtt, DOOR, LANDING, PRESENCE);
    expect(lampOn(mqtt)).toBe(1);
  });

  it('is not walked when it takes longer than the route’s time', async () => {
    const { mqtt } = await harness([route({ walkMs: 5_000 })], [walkedRule()]);
    walk(mqtt, DOOR, MOTION);
    vi.advanceTimersByTime(4_000);
    walk(mqtt, PRESENCE);
    expect(lampOn(mqtt)).toBe(0);
  });

  it('takes a sensor coming on, not one still saying it is on', async () => {
    const { mqtt } = await harness([route({ bothWays: false })], [walkedRule()]);
    walk(mqtt, DOOR, MOTION, LANDING);
    // The hallway still occupied, said again with whatever else it reports.
    walk(mqtt, MOTION, PRESENCE);
    expect(lampOn(mqtt)).toBe(1);
  });

  it('does not count what the broker replays on connect', async () => {
    const { mqtt } = await harness([route()], [walkedRule()]);
    mqtt.deliver(DOOR.topic, reading(DOOR.topic, true), { retained: true });
    walk(mqtt, MOTION, PRESENCE);
    expect(lampOn(mqtt)).toBe(0);
  });

  it('goes back the other way only on a route that goes both ways', async () => {
    const both = await harness([route()], [walkedRule()]);
    walk(both.mqtt, PRESENCE, LANDING, MOTION, DOOR);
    expect(lampOn(both.mqtt)).toBe(1);
    expect(both.engine.getLog()[0]).toMatchObject({ walked: { direction: 'back' } });

    const one = await harness([route({ bothWays: false })], [walkedRule()]);
    walk(one.mqtt, PRESENCE, LANDING, MOTION, DOOR);
    expect(lampOn(one.mqtt)).toBe(0);
  });

  it('takes a direction from the trigger, towards one end', async () => {
    const { mqtt } = await harness([route()], [walkedRule({}, 'back')]);
    walk(mqtt, DOOR, MOTION, PRESENCE);
    expect(lampOn(mqtt)).toBe(0);

    clear(mqtt, DOOR, MOTION, PRESENCE);
    vi.advanceTimersByTime(60_000);
    walk(mqtt, PRESENCE, LANDING, DOOR);
    expect(lampOn(mqtt)).toBe(1);
  });

  it('waits when the rule says to, and nothing calls the wait off', async () => {
    const { mqtt, engine } = await harness([route()], [walkedRule({ waitMs: 10_000 })]);
    walk(mqtt, DOOR, MOTION, PRESENCE);
    expect(engine.getLog()[0]).toMatchObject({ outcome: 'waiting', walked: { routeId: 'route-1' } });

    clear(mqtt, DOOR, MOTION, PRESENCE);
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
    mqtt.deliver('zigbee2mqtt/bridge/devices', [...fixture, ...safety, landing], {
      retained: true,
    });
    const engine = new RulesEngine(catalog, store, mqtt.asConnection(), silentLogger, undefined, {
      send: async (_title, message) => {
        sent.push(message);
      },
    });
    catalog.on('state', (update) => engine.handleState(update));

    walk(mqtt, DOOR, PRESENCE);
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
