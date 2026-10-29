import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Catalog } from '../src/catalog.js';
import { resolveConfig } from '../src/config.js';
import { silentLogger } from '../src/logger.js';
import { MqttConnection } from '../src/mqtt/client.js';
import { RulesEngine } from '../src/rules/engine.js';
import type { AnyRule } from '../src/rules/types.js';
import { STATES_SOURCE, StateToggles } from '../src/states.js';
import { Store } from '../src/store.js';
import { WebServer } from '../src/web/server.js';
import fixture from './fixtures/bridge-devices.json' with { type: 'json' };
import { FakeMqtt } from './helpers/fake-mqtt.js';

const SOCKET = { id: '0x00158dfffe000006', topic: 'zigbee2mqtt/living_room_lamp-socket' };
const LAMP = { id: '0x00158dfffe000003', topic: 'zigbee2mqtt/kitchen_dimmer-candeo' };

const device = (deviceId: string, propertyKey = 'state') => ({
  sourceId: 'zigbee',
  deviceId,
  propertyKey,
});
const toggle = (deviceId: string) => ({ sourceId: STATES_SOURCE, deviceId, propertyKey: 'state' });

/** Lets a write to a toggle come back, the way an answer from the broker would. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function harness(rules: AnyRule[] = [], file?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'mq77-states-'));
  const store = new Store(file ?? join(directory, 'state.json'), silentLogger);
  await store.load();
  store.update((state) => {
    state.rules = rules;
  });

  const mqtt = new FakeMqtt();
  const catalog = new Catalog(mqtt.asConnection(), silentLogger);
  await catalog.start([{ id: 'zigbee', adapter: 'zigbee2mqtt', baseTopic: 'zigbee2mqtt' }]);
  mqtt.deliver('zigbee2mqtt/bridge/devices', fixture, { retained: true });

  const toggles = new StateToggles(store, mqtt.asConnection(), silentLogger);
  await catalog.attach(toggles);

  const engine = new RulesEngine(catalog, store, mqtt.asConnection(), silentLogger);
  catalog.on('state', (update) => engine.handleState(update));
  return { store, mqtt, catalog, toggles, engine, file: join(directory, 'state.json') };
}

const automation = (over: Partial<AnyRule>): AnyRule =>
  ({
    id: 'r1',
    name: 'Regel',
    enabled: true,
    rateLimitMs: 0,
    triggers: [],
    branches: [{ actions: [] }],
    ...over,
  }) as AnyRule;

describe('a state toggle as a device', () => {
  it('is a rules only device with one true or false that can be read and written', async () => {
    const { catalog, toggles } = await harness();
    const away = toggles.create('Away');

    const listed = catalog.getDevice(STATES_SOURCE, away.id);
    expect(listed).toMatchObject({ name: 'Away', rulesOnly: true, renameable: false });
    expect(listed?.properties).toHaveLength(1);
    expect(listed?.properties[0]).toMatchObject({
      key: 'state',
      type: 'binary',
      access: { readable: true, writable: true },
      onValue: true,
      offValue: false,
      toggleValue: 'toggle',
    });
    // False until something says otherwise.
    expect(catalog.getState(STATES_SOURCE, away.id)).toEqual({ state: false });
  });

  it('keeps its name and value across a restart', async () => {
    const first = await harness();
    const away = first.toggles.create('Away');
    first.toggles.set(away.id, true);
    await first.store.save();

    const second = await harness([], first.file);
    expect(second.catalog.getDevice(STATES_SOURCE, away.id)?.name).toBe('Away');
    expect(second.catalog.getState(STATES_SOURCE, away.id)).toEqual({ state: true });
  });

  it('goes from the catalog when it is deleted, room and all', async () => {
    const { catalog, toggles, store } = await harness();
    const away = toggles.create('Away');
    store.setExposure(`${STATES_SOURCE}:${away.id}`, { properties: [], room: 'Gang' });

    toggles.remove(away.id);
    expect(catalog.getDevice(STATES_SOURCE, away.id)).toBeUndefined();
    expect(store.getExposure(`${STATES_SOURCE}:${away.id}`)).toBeUndefined();
  });

  it('never reaches the broker', async () => {
    const { mqtt, toggles, engine, store } = await harness();
    const away = toggles.create('Away');
    store.update((state) => {
      state.rules = [
        automation({
          triggers: [{ ...device(SOCKET.id), match: { kind: 'changedTo', value: 'ON' } }],
          branches: [{ actions: [{ ...toggle(away.id), value: 'true' }] }],
        }),
      ];
    });

    mqtt.deliver(SOCKET.topic, { state: 'ON' });
    await settle();

    expect(toggles.find(away.id)?.value).toBe(true);
    expect(mqtt.published).toEqual([]);
    expect(engine.getLog().some((entry) => entry.outcome === 'failed')).toBe(false);
  });
});

describe('the local topics', () => {
  it('hand a publish back without a broker, and later rather than at once', async () => {
    const connection = new MqttConnection({ host: 'nowhere', port: 1883 }, silentLogger);
    const heard: string[] = [];
    connection.subscribe('$mq77/states/+/set', (message) => heard.push(message.payload.toString()));

    connection.publish('$mq77/states/abc/set', '{"state":true}');
    expect(heard).toEqual([]);
    await settle();
    expect(heard).toEqual(['{"state":true}']);
  });

  it('are out of reach of a wildcard on the broker side', async () => {
    const connection = new MqttConnection({ host: 'nowhere', port: 1883 }, silentLogger);
    const heard: string[] = [];
    connection.subscribe('#', (message) => heard.push(message.topic));
    connection.publish('$mq77/states/abc/set', '{"state":true}');
    await settle();
    expect(heard).toEqual([]);
  });
});

describe('a state toggle in rules', () => {
  it('sets a rule off when it becomes true', async () => {
    const { toggles, store, mqtt } = await harness();
    const away = toggles.create('Away');
    store.update((state) => {
      state.rules = [
        automation({
          triggers: [{ ...toggle(away.id), match: { kind: 'changedTo', value: 'true' } }],
          branches: [{ actions: [{ ...device(SOCKET.id), value: 'OFF' }] }],
        }),
      ];
    });

    toggles.set(away.id, true, true);
    expect(mqtt.published.map((message) => message.payload)).toEqual(['{"state":"OFF"}']);
  });

  it('is set, and flipped, by an action', async () => {
    const { toggles, store, mqtt } = await harness();
    const guests = toggles.create('Guests');
    const send = (value: string) => {
      store.update((state) => {
        state.rules = [
          automation({
            triggers: [{ ...device(SOCKET.id), match: { kind: 'changed' } }],
            branches: [{ actions: [{ ...toggle(guests.id), value }] }],
          }),
        ];
      });
    };

    send('true');
    mqtt.deliver(SOCKET.topic, { state: 'ON' });
    await settle();
    expect(toggles.find(guests.id)?.value).toBe(true);

    send('toggle');
    mqtt.deliver(SOCKET.topic, { state: 'OFF' });
    await settle();
    expect(toggles.find(guests.id)?.value).toBe(false);

    mqtt.deliver(SOCKET.topic, { state: 'ON' });
    await settle();
    expect(toggles.find(guests.id)?.value).toBe(true);
  });

  it('is asked in a condition', async () => {
    const { toggles, store, mqtt } = await harness();
    const away = toggles.create('Away');
    store.update((state) => {
      state.rules = [
        automation({
          triggers: [{ ...device(SOCKET.id), match: { kind: 'changedTo', value: 'ON' } }],
          branches: [
            {
              when: { kind: 'test', ...toggle(away.id), match: { kind: 'equals', value: 'false' } },
              actions: [{ ...device(LAMP.id), value: 'ON' }],
            },
          ],
        }),
      ];
    });

    toggles.set(away.id, true);
    mqtt.deliver(SOCKET.topic, { state: 'ON' });
    expect(mqtt.published).toEqual([]);

    mqtt.deliver(SOCKET.topic, { state: 'OFF' });
    toggles.set(away.id, false);
    mqtt.deliver(SOCKET.topic, { state: 'ON' });
    expect(mqtt.published.map((message) => message.topic)).toEqual([`${LAMP.topic}/set`]);
  });

  it('follows a lamp it is copied from, in its own words', async () => {
    const { toggles, store, mqtt } = await harness();
    const lit = toggles.create('Lit');
    store.update((state) => {
      state.rules = [
        automation({
          triggers: [{ ...device(SOCKET.id), match: { kind: 'changed' } }],
          branches: [{ actions: [{ ...toggle(lit.id), valueFrom: { kind: 'trigger' } }] }],
        }),
      ];
    });

    mqtt.deliver(SOCKET.topic, { state: 'ON' });
    await settle();
    expect(toggles.find(lit.id)?.value).toBe(true);
  });
});

describe('a state toggle in the activity log', () => {
  it('has a line for every change, saying when it was by hand', async () => {
    const { toggles, engine } = await harness();
    const away = toggles.create('Away');

    toggles.set(away.id, true, true);
    // Already true: nothing changed, so nothing to say.
    toggles.set(away.id, true, true);
    toggles.set(away.id, false);

    const lines = engine.getLog().filter((entry) => entry.ruleKind === 'state');
    expect(lines.map((entry) => [entry.detail, entry.byHand ?? false])).toEqual([
      ['Away false', false],
      ['Away true (by hand)', true],
    ]);
    expect(lines[0]?.changed).toEqual({ ...toggle(away.id), value: 'false' });
  });

  it('puts the change under the rule that made it', async () => {
    const { toggles, store, mqtt, engine } = await harness();
    const away = toggles.create('Away');
    store.update((state) => {
      state.rules = [
        automation({
          name: 'Weg',
          triggers: [{ ...device(SOCKET.id), match: { kind: 'changedTo', value: 'OFF' } }],
          branches: [{ actions: [{ ...toggle(away.id), value: 'true' }] }],
        }),
      ];
    });

    mqtt.deliver(SOCKET.topic, { state: 'OFF' });
    await settle();

    // Newest first.
    expect(engine.getLog().map((entry) => entry.ruleName)).toEqual(['Away', 'Weg']);
  });
});

describe('the source id', () => {
  it('is kept for the toggles', () => {
    const settings = resolveConfig(
      {
        sources: [
          { id: 'states', adapter: 'zigbee2mqtt', baseTopic: 'z' },
          { id: 'zigbee', adapter: 'zigbee2mqtt', baseTopic: 'zigbee2mqtt' },
        ],
      },
      silentLogger,
    );
    expect(settings.sources.map((source) => source.id)).toEqual(['zigbee']);
  });
});

describe('the web interface', () => {
  let server: WebServer | undefined;
  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  async function serve() {
    const context = await harness();
    server = new WebServer({
      config: { port: 0, password: 'pw' },
      catalog: context.catalog,
      store: context.store,
      rules: context.engine,
      states: context.toggles,
      log: silentLogger,
      onExposureChanged: () => {},
    });
    await server.start();
    const base = `http://127.0.0.1:${server.port}`;
    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'pw' }),
    });
    const cookie = login.headers.getSetCookie()[0]?.split(';')[0] ?? '';
    const call = (path: string, init: RequestInit = {}) =>
      fetch(`${base}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
      });
    return { ...context, call };
  }

  const listed = async (call: (path: string) => Promise<Response>) =>
    ((await (await call('/api/state')).json()) as {
      devices: { sourceId: string; deviceId: string; name: string; exposure: unknown; state: unknown }[];
    }).devices.filter((entry) => entry.sourceId === STATES_SOURCE);

  it('makes, names, flips and deletes one', async () => {
    const { call, toggles } = await serve();

    const made = (await (await call('/api/states', { method: 'POST', body: '{}' })).json()) as {
      id: string;
    };
    expect(toggles.find(made.id)).toEqual({
      id: made.id,
      name: 'New state',
      type: 'boolean',
      value: false,
    });

    await call(`/api/states/${made.id}`, {
      method: 'PUT',
      body: JSON.stringify({ name: ' Away ', value: true }),
    });
    expect(toggles.find(made.id)).toEqual({ id: made.id, name: 'Away', type: 'boolean', value: true });

    expect(
      (await call(`/api/states/${made.id}`, { method: 'PUT', body: '{"name":"  "}' })).status,
    ).toBe(400);
    expect(
      (await call(`/api/states/${made.id}`, { method: 'PUT', body: '{"value":"yes"}' })).status,
    ).toBe(400);

    expect((await call(`/api/states/${made.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(toggles.find(made.id)).toBeUndefined();
    expect((await call(`/api/states/${made.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('lists one as the state kind, in no room and with nothing for HomeKit', async () => {
    const { call, toggles, store } = await serve();
    store.update((state) => {
      state.rooms = ['Gang'];
    });
    const away = toggles.create('Away');

    await call('/api/exposure', {
      method: 'PUT',
      body: JSON.stringify({
        sourceId: STATES_SOURCE,
        deviceId: away.id,
        exposure: { properties: ['state'], room: 'Gang', type: 'light', label: 'x' },
      }),
    });

    expect(await listed(call)).toEqual([
      expect.objectContaining({
        name: 'Away',
        exposure: { properties: [], type: 'state' },
        state: { state: false },
      }),
    ]);
    expect(store.getExposure(`${STATES_SOURCE}:${away.id}`)).toBeUndefined();
  });

  it('takes a type, and only values that type can hold', async () => {
    const { call, toggles } = await serve();
    const made = (await (
      await call('/api/states', { method: 'POST', body: '{"type":"number"}' })
    ).json()) as { id: string };
    expect(toggles.find(made.id)).toMatchObject({ type: 'number', value: 0 });

    const put = (body: unknown) =>
      call(`/api/states/${made.id}`, { method: 'PUT', body: JSON.stringify(body) });
    expect((await put({ value: -4 })).status).toBe(200);
    expect(toggles.find(made.id)?.value).toBe(-4);
    expect((await put({ value: 1.5 })).status).toBe(400);

    // A new type and a value for it, in one go.
    expect((await put({ type: 'boolean', value: true })).status).toBe(200);
    expect(toggles.find(made.id)).toMatchObject({ type: 'boolean', value: true });
    // Text is not a type any more, and is refused whole: not renamed either.
    expect((await put({ name: 'Ander', type: 'text' })).status).toBe(400);
    expect(toggles.find(made.id)?.name).toBe('New state');
  });

  it('does not let another device be one', async () => {
    const { call, store } = await serve();
    await call('/api/exposure', {
      method: 'PUT',
      body: JSON.stringify({
        sourceId: 'zigbee',
        deviceId: SOCKET.id,
        exposure: { properties: [], type: 'state' },
      }),
    });
    expect(store.getExposure(`zigbee:${SOCKET.id}`)?.type).toBeUndefined();
  });

  it('leaves the rules that used a deleted one as they were', async () => {
    const { call, toggles, store } = await serve();
    const away = toggles.create('Away');
    store.update((state) => {
      state.rules = [
        automation({
          triggers: [{ ...toggle(away.id), match: { kind: 'changedTo', value: 'true' } }],
          branches: [{ actions: [{ ...device(SOCKET.id), value: 'OFF' }] }],
        }),
      ];
    });

    await call(`/api/states/${away.id}`, { method: 'DELETE' });
    expect(store.data.rules[0]).toMatchObject({ triggers: [toggle(away.id)] });
  });
});

describe('the two types', () => {
  it('reads a Number as a whole one', async () => {
    const { toggles, catalog } = await harness();
    const guests = toggles.create('Gasten', 'number');

    expect(catalog.getDevice(STATES_SOURCE, guests.id)?.properties[0]).toMatchObject({
      type: 'numeric',
      step: 1,
    });
    expect(toggles.find(guests.id)?.value).toBe(0);

    toggles.set(guests.id, '-3.7');
    expect(toggles.find(guests.id)?.value).toBe(-3);
    expect(toggles.set(guests.id, 'veel')).toBe(false);
    expect(toggles.find(guests.id)?.value).toBe(-3);
  });

  it('starts again from its new type when that changes', async () => {
    const { toggles, engine } = await harness();
    const away = toggles.create('Away');
    toggles.set(away.id, true);

    toggles.retype(away.id, 'number');
    expect(toggles.find(away.id)).toMatchObject({ type: 'number', value: 0 });
    expect(engine.getLog()[0]?.detail).toBe('Away 0');
  });

  it('counts up and down by an action', async () => {
    const { toggles, store, mqtt } = await harness();
    const guests = toggles.create('Gasten', 'number');
    store.update((state) => {
      state.rules = [
        automation({
          triggers: [{ ...device(SOCKET.id), match: { kind: 'changed' } }],
          branches: [{ actions: [{ ...toggle(guests.id), valueFrom: { kind: 'add' }, value: 2 }] }],
        }),
      ];
    });

    mqtt.deliver(SOCKET.topic, { state: 'ON' });
    await settle();
    mqtt.deliver(SOCKET.topic, { state: 'OFF' });
    await settle();
    expect(toggles.find(guests.id)?.value).toBe(4);
  });

  it('is asked in a condition by number', async () => {
    const { toggles, store, mqtt } = await harness();
    const guests = toggles.create('Gasten', 'number');
    store.update((state) => {
      state.rules = [
        automation({
          triggers: [{ ...device(SOCKET.id), match: { kind: 'changedTo', value: 'ON' } }],
          branches: [
            {
              when: { kind: 'test', ...toggle(guests.id), match: { kind: 'above', value: 2 } },
              actions: [{ ...device(LAMP.id), value: 'ON' }],
            },
          ],
        }),
      ];
    });

    toggles.set(guests.id, 2);
    mqtt.deliver(SOCKET.topic, { state: 'ON' });
    expect(mqtt.published).toEqual([]);

    mqtt.deliver(SOCKET.topic, { state: 'OFF' });
    toggles.set(guests.id, 3);
    mqtt.deliver(SOCKET.topic, { state: 'ON' });
    expect(mqtt.published.map((message) => message.topic)).toEqual([`${LAMP.topic}/set`]);
  });
});

describe('settings from before', () => {
  async function loaded(saved: unknown) {
    const directory = await mkdtemp(join(tmpdir(), 'mq77-states-'));
    const file = join(directory, 'state.json');
    await writeFile(file, JSON.stringify({ version: 1, ...(saved as object) }), 'utf8');
    const store = new Store(file, silentLogger);
    await store.load();
    return store;
  }

  it('deletes a Text state, and keeps a room for none', async () => {
    const store = await loaded({
      states: [
        { id: 'a', name: 'Away', type: 'boolean', value: true },
        { id: 'm', name: 'Modus', type: 'text', value: 'film' },
        { id: 'g', name: 'Gasten', type: 'number', value: 2 },
      ],
      exposures: {
        'states:a': { properties: [], room: 'Gang' },
        'states:m': { properties: [], room: 'Gang' },
        [`zigbee:${SOCKET.id}`]: { properties: ['state'], room: 'Gang' },
      },
    });

    expect(store.data.states.map((one) => one.id)).toEqual(['a', 'g']);
    expect(Object.keys(store.data.exposures)).toEqual([`zigbee:${SOCKET.id}`]);
  });

  it('asks a truth what it is offered now, where that means the same', async () => {
    const away = toggle('a');
    const guests = toggle('g');
    const store = await loaded({
      states: [
        { id: 'a', name: 'Away', type: 'boolean', value: false },
        { id: 'g', name: 'Gasten', type: 'number', value: 0 },
      ],
      rules: [
        {
          id: 'r1',
          name: 'Thuis',
          enabled: true,
          triggers: [
            { ...away, match: { kind: 'equals', value: true } },
            { ...away, match: { kind: 'notEquals', value: 'true' } },
            // A number keeps whatever it was asked.
            { ...guests, match: { kind: 'equals', value: 2 } },
          ],
          branches: [
            {
              when: {
                kind: 'any',
                nodes: [
                  { kind: 'test', ...away, match: { kind: 'notEquals', value: false } },
                  {
                    kind: 'not',
                    node: { kind: 'test', ...away, match: { kind: 'changedTo', value: 'true' } },
                  },
                  // Nothing it means the same as, so it is left.
                  { kind: 'test', ...away, match: { kind: 'changed' } },
                ],
              },
              actions: [{ ...away, valueFrom: { kind: 'trigger' } }],
            },
          ],
        },
      ],
    });

    const rule = store.data.rules[0] as unknown as {
      triggers: unknown[];
      branches: { when: { nodes: unknown[] }; actions: unknown[] }[];
    };
    expect(rule.triggers).toEqual([
      { ...away, match: { kind: 'changedTo', value: true } },
      { ...away, match: { kind: 'changedTo', value: 'false' } },
      { ...guests, match: { kind: 'equals', value: 2 } },
    ]);
    expect(rule.branches[0]?.when.nodes).toEqual([
      { kind: 'test', ...away, match: { kind: 'equals', value: true } },
      { kind: 'not', node: { kind: 'test', ...away, match: { kind: 'equals', value: 'true' } } },
      { kind: 'test', ...away, match: { kind: 'changed' } },
    ]);
    expect(rule.branches[0]?.actions).toEqual([{ ...away, valueFrom: { kind: 'trigger' } }]);
  });
});
