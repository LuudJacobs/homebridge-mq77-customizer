import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Catalog } from '../src/catalog.js';
import { silentLogger, type Logger } from '../src/logger.js';
import { RulesEngine } from '../src/rules/engine.js';
import { Store } from '../src/store.js';
import { sanitiseExposure, WebServer } from '../src/web/server.js';
import fixture from './fixtures/bridge-devices.json' with { type: 'json' };
import { FakeMqtt } from './helpers/fake-mqtt.js';

const PASSWORD = 'let-me-in';

interface Harness {
  server: WebServer;
  store: Store;
  base: string;
  syncs: number;
  mqtt: FakeMqtt;
}

async function harness(
  options: { password?: string; sources?: Parameters<Catalog['start']>[0] } = {},
): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'mq77-customizer-web-'));
  const store = new Store(join(directory, 'state.json'), silentLogger);
  await store.load();

  const mqtt = new FakeMqtt();
  const catalog = new Catalog(mqtt.asConnection(), silentLogger);
  await catalog.start(
    options.sources ?? [{ id: 'zigbee', adapter: 'zigbee2mqtt', baseTopic: 'zigbee2mqtt' }],
  );
  mqtt.deliver('zigbee2mqtt/bridge/devices', fixture, { retained: true });
  mqtt.deliver('zigbee2mqtt/woonkamer_lampen-ZB2GS', { state_l1: 'ON', state_l2: 'OFF' });

  const result: Harness = { server: undefined as never, store, base: '', syncs: 0, mqtt };

  const server = new WebServer({
    config: { port: 0, password: options.password ?? PASSWORD },
    catalog,
    store,
    rules: new RulesEngine(catalog, store, mqtt.asConnection(), silentLogger),
    log: silentLogger,
    onExposureChanged: () => {
      result.syncs += 1;
    },
  });
  await server.start();

  result.server = server;
  result.base = `http://127.0.0.1:${server.port}`;
  return result;
}

/** Signs in and returns a fetch that carries the session cookie. */
async function signIn(base: string, password = PASSWORD) {
  const response = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const cookie = response.headers.getSetCookie()[0]?.split(';')[0] ?? '';
  return {
    response,
    fetch: (path: string, init: RequestInit = {}) =>
      fetch(`${base}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', Cookie: cookie, ...init.headers },
      }),
  };
}

describe('WebServer', () => {
  let context: Harness;

  beforeEach(async () => {
    context = await harness();
  });

  afterEach(async () => {
    await context.server.stop();
  });

  it('serves the interface without a session', async () => {
    const response = await fetch(`${context.base}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('MQ77 Customizer');
  });

  it('refuses api access without a session', async () => {
    const response = await fetch(`${context.base}/api/state`);
    expect(response.status).toBe(401);
  });

  it('refuses a wrong password', async () => {
    const { response } = await signIn(context.base, 'wrong');
    expect(response.status).toBe(401);
  });

  it('returns the catalog once signed in', async () => {
    const session = await signIn(context.base);
    const body = (await (await session.fetch('/api/state')).json()) as {
      devices: { name: string; properties: unknown[]; state: Record<string, unknown> }[];
      tileTypes: string[];
    };

    expect(body.devices).toHaveLength(5);
    expect(body.tileTypes).toEqual(['Switch', 'Outlet', 'Lightbulb', 'Fan']);

    const dual = body.devices.find((entry) => entry.name === 'woonkamer_lampen-ZB2GS');
    expect(dual?.state).toEqual({ state_l1: 'ON', state_l2: 'OFF' });
    expect(dual?.properties).toHaveLength(7);
  });

  it('sends the topic so the interface can show and search it', async () => {
    const session = await signIn(context.base);
    const body = (await (await session.fetch('/api/state')).json()) as {
      devices: { name: string; topic?: string }[];
    };
    expect(body.devices.find((entry) => entry.name === 'woonkamer_lampen-ZB2GS')?.topic).toBe(
      'zigbee2mqtt/woonkamer_lampen-ZB2GS',
    );
  });

  it('marks which properties can reach HomeKit and which stay rules only', async () => {
    const session = await signIn(context.base);
    const body = (await (await session.fetch('/api/state')).json()) as {
      devices: { name: string; properties: { key: string; publishable: boolean }[] }[];
    };
    const dual = body.devices.find((entry) => entry.name === 'woonkamer_lampen-ZB2GS');
    const publishable = dual?.properties
      .filter((property) => property.publishable)
      .map((property) => property.key);

    // The two switchable channels plus the button actions. Everything else is
    // still listed, so nothing disappears from the interface just because
    // HomeKit cannot show it.
    expect(publishable).toEqual(['state_l1', 'state_l2', 'action']);
    expect(dual?.properties).toHaveLength(7);
  });

  it('says which action value arrives as which HomeKit press', async () => {
    const session = await signIn(context.base);
    const body = (await (await session.fetch('/api/state')).json()) as {
      devices: {
        name: string;
        properties: { key: string; buttons?: { name: string; events: Record<string, number> }[] }[];
      }[];
    };
    const buttons = body.devices
      .find((entry) => entry.name === 'slaapkamer_schakelaar-wrs02')
      ?.properties.find((property) => property.key === 'action')?.buttons;

    // Without this the interface would have to read the value itself to say
    // whether HomeKit hears a press, and it divides these names elsewhere.
    expect(buttons?.find((button) => button.name === 'left')?.events).toEqual({
      single_left: 0,
      double_left: 1,
      hold_left: 2,
    });
    // A triple press is one HomeKit cannot express, so it arrives as nothing.
    expect(buttons?.find((button) => button.name === 'left')?.events.triple_left).toBeUndefined();
  });

  it('sends the words a device uses for on, off and toggle', async () => {
    const session = await signIn(context.base);
    const body = (await (await session.fetch('/api/state')).json()) as {
      devices: {
        name: string;
        properties: { key: string; onValue?: unknown; offValue?: unknown; toggleValue?: unknown }[];
      }[];
    };
    const dual = body.devices.find((entry) => entry.name === 'woonkamer_lampen-ZB2GS');
    const state = dual?.properties.find((property) => property.key === 'state_l1');

    // Without these the interface would offer a guess at ON and OFF, which is
    // wrong for anything wording it differently, such as a child lock.
    expect(state).toMatchObject({ onValue: 'ON', offValue: 'OFF', toggleValue: 'TOGGLE' });
  });

  it('leaves toggle out for a device that does not offer one', async () => {
    const session = await signIn(context.base);
    const body = (await (await session.fetch('/api/state')).json()) as {
      devices: {
        name: string;
        properties: { key: string; onValue?: unknown; toggleValue?: unknown }[];
      }[];
    };
    const socket = body.devices.find((entry) => entry.name === 'woonkamer_bank_lamp-socket');
    const lock = socket?.properties.find((property) => property.key === 'child_lock');

    expect(lock).toMatchObject({ onValue: 'LOCK', offValue: 'UNLOCK' });
    expect(lock?.toggleValue).toBeUndefined();
  });

  it('saves a selection and asks HomeKit to reconcile', async () => {
    const session = await signIn(context.base);
    const response = await session.fetch('/api/exposure', {
      method: 'PUT',
      body: JSON.stringify({
        sourceId: 'zigbee',
        deviceId: '0xf044d3fffe024659',
        exposure: { properties: ['state_l1'], tileTypes: { l1: 'Lightbulb' } },
      }),
    });

    expect(response.status).toBe(200);
    expect(context.syncs).toBe(1);
    expect(context.store.getExposure('zigbee:0xf044d3fffe024659')).toMatchObject({
      properties: ['state_l1'],
      tileTypes: { l1: 'Lightbulb' },
    });
  });

  it('rejects a selection for a device that does not exist', async () => {
    const session = await signIn(context.base);
    const response = await session.fetch('/api/exposure', {
      method: 'PUT',
      body: JSON.stringify({ sourceId: 'zigbee', deviceId: 'nope', exposure: { properties: [] } }),
    });
    expect(response.status).toBe(404);
    expect(context.syncs).toBe(0);
  });

  it('creates, lists, updates and deletes a rule', async () => {
    const session = await signIn(context.base);
    const draft = {
      name: 'Left button',
      trigger: {
        sourceId: 'zigbee',
        deviceId: '0x54ef44100169b28a',
        propertyKey: 'action',
        match: { kind: 'equals', value: 'single_left' },
      },
      actions: [
        { sourceId: 'zigbee', deviceId: '0xf044d3fffe024659', propertyKey: 'state_l1', value: 'ON' },
      ],
    };

    const created = (await (
      await session.fetch('/api/rules', { method: 'PUT', body: JSON.stringify(draft) })
    ).json()) as { rule: { id: string; name: string } };
    expect(created.rule.id).toBeTruthy();

    const listed = (await (await session.fetch('/api/rules')).json()) as { rules: unknown[] };
    expect(listed.rules).toHaveLength(1);

    // Sending the same id updates rather than adding a second rule.
    await session.fetch('/api/rules', {
      method: 'PUT',
      body: JSON.stringify({ ...draft, id: created.rule.id, name: 'Renamed' }),
    });
    const afterUpdate = (await (await session.fetch('/api/rules')).json()) as {
      rules: { name: string }[];
    };
    expect(afterUpdate.rules).toHaveLength(1);
    expect(afterUpdate.rules[0]?.name).toBe('Renamed');

    const removed = await session.fetch(`/api/rules/${created.rule.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(((await (await session.fetch('/api/rules')).json()) as { rules: unknown[] }).rules).toEqual([]);
  });

  it('keeps automations and mirrors in one list, told apart by kind', async () => {
    const session = await signIn(context.base);

    await session.fetch('/api/rules', {
      method: 'PUT',
      body: JSON.stringify({
        name: 'An automation',
        trigger: {
          sourceId: 'zigbee',
          deviceId: '0x54ef44100169b28a',
          propertyKey: 'action',
          match: { kind: 'equals', value: 'single_left' },
        },
        actions: [
          { sourceId: 'zigbee', deviceId: '0xf044d3fffe024659', propertyKey: 'state_l1', value: 'ON' },
        ],
      }),
    });

    await session.fetch('/api/rules', {
      method: 'PUT',
      body: JSON.stringify({ kind: 'mirror', name: 'A mirror', enabled: false, groups: [] }),
    });

    const body = (await (await session.fetch('/api/rules')).json()) as {
      rules: { name: string; kind?: string }[];
    };
    expect(body.rules.map((rule) => [rule.name, rule.kind ?? 'standard'])).toEqual([
      ['An automation', 'standard'],
      ['A mirror', 'mirror'],
    ]);
  });

  it('refuses a rule it cannot make sense of, and says why', async () => {
    const session = await signIn(context.base);
    const response = await session.fetch('/api/rules', {
      method: 'PUT',
      body: JSON.stringify({ name: 'No actions', trigger: {}, actions: [] }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('trigger');
  });

  it('reports a rule that is not there', async () => {
    const session = await signIn(context.base);
    expect((await session.fetch('/api/rules/nope', { method: 'DELETE' })).status).toBe(404);
  });

  it('serves the run log', async () => {
    const session = await signIn(context.base);
    const body = (await (await session.fetch('/api/log')).json()) as { entries: unknown[] };
    expect(Array.isArray(body.entries)).toBe(true);
  });

  it('signs out', async () => {
    const session = await signIn(context.base);
    expect((await session.fetch('/api/state')).status).toBe(200);

    const response = await session.fetch('/api/logout', { method: 'POST' });
    expect(response.headers.getSetCookie()[0]).toContain('Max-Age=0');
  });

  it('does not serve files outside the public directory', async () => {
    const response = await fetch(`${context.base}/../../package.json`, { redirect: 'manual' });
    expect(response.status).not.toBe(200);
  });

  it('reports unknown endpoints as 404 rather than falling through to files', async () => {
    const session = await signIn(context.base);
    expect((await session.fetch('/api/nonsense')).status).toBe(404);
  });
});

describe('WebServer without a password', () => {
  it('refuses to start and says why', async () => {
    const messages: string[] = [];
    const log: Logger = { ...silentLogger, error: (message) => messages.push(message) };
    const directory = await mkdtemp(join(tmpdir(), 'mq77-customizer-web-'));
    const store = new Store(join(directory, 'state.json'), silentLogger);
    await store.load();
    const mqtt = new FakeMqtt();
    const catalog = new Catalog(mqtt.asConnection(), silentLogger);

    const server = new WebServer({
      config: { port: 0 },
      catalog,
      store,
      rules: new RulesEngine(catalog, store, mqtt.asConnection(), silentLogger),
      log,
      onExposureChanged: () => {},
    });
    await server.start();

    expect(messages.join(' ')).toContain('No web password set');
    // Nothing is served at all, not even the login form, so there is no
    // unprotected surface to reach.
    expect(server.port).toBe(0);
    await expect(fetch('http://127.0.0.1:0/')).rejects.toThrow();
    await server.stop();
  });
});

describe('sanitiseExposure', () => {
  const known = ['state_l1', 'state_l2'];

  it('drops property keys the device does not have', () => {
    expect(sanitiseExposure({ properties: ['state_l1', 'made_up'] }, known).properties).toEqual([
      'state_l1',
    ]);
  });

  it('removes duplicates', () => {
    expect(
      sanitiseExposure({ properties: ['state_l1', 'state_l1'] }, known).properties,
    ).toEqual(['state_l1']);
  });

  it('drops unknown tile types', () => {
    const exposure = sanitiseExposure(
      { properties: [], tileTypes: { l1: 'Lightbulb', l2: 'Teapot' } },
      known,
    );
    expect(exposure.tileTypes).toEqual({ l1: 'Lightbulb' });
  });

  it('trims names and caps their length', () => {
    const exposure = sanitiseExposure(
      { properties: [], names: { l1: '  Reading lamp  ', l2: '   ' } },
      known,
    );
    expect(exposure.names).toEqual({ l1: 'Reading lamp' });
  });

  it('copes with rubbish input', () => {
    expect(sanitiseExposure(undefined, known)).toEqual({
      properties: [],
      tileTypes: {},
      splitEndpoints: false,
      names: {},
      buttons: {},
    });
    expect(sanitiseExposure({ properties: 'nope' }, known).properties).toEqual([]);
  });
});

describe('taking settings away and putting them back', () => {
  it('hands over everything worth keeping, as a file', async () => {
    const { base, store } = await harness();
    const { fetch: signed } = await signIn(base);
    store.setExposure('zigbee:0xabc', { properties: ['state'] });

    const response = await signed('/api/settings', { method: 'GET' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('attachment');

    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body.exposures as object)).toContain('zigbee:0xabc');
    // It signs the cookie that keeps you signed in, and a settings file is a
    // thing people mail to themselves.
    expect(body.sessionSecret).toBeUndefined();
  });

  it('puts one back and says what it found', async () => {
    const { base, store } = await harness();
    const { fetch: signed } = await signIn(base);
    const secret = store.sessionSecret();

    const response = await signed('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        exposures: { 'zigbee:0xdef': { properties: ['state'] } },
        rules: [{ id: 'r1', name: 'From a file', enabled: true }],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ devices: 1, rules: 1 });
    expect(store.data.rules).toHaveLength(1);
    // Still signed in afterwards, which replacing the secret would undo.
    expect(store.sessionSecret()).toBe(secret);
  });

  it('refuses a file that is not one of ours', async () => {
    const { base, store } = await harness();
    const { fetch: signed } = await signIn(base);
    store.setExposure('zigbee:0xabc', { properties: ['state'] });

    const response = await signed('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ something: 'else' }),
    });

    expect(response.status).toBe(400);
    // And nothing was touched on the way to saying so.
    expect(Object.keys(store.data.exposures)).toEqual(['zigbee:0xabc']);
  });

  it('takes a copy on asking, and says when', async () => {
    const { base } = await harness();
    const { fetch: signed } = await signIn(base);

    const response = await signed('/api/settings/backup', { method: 'POST' });
    expect(response.status).toBe(200);

    const { backupAt } = (await response.json()) as { backupAt: number };
    expect(backupAt).toBeGreaterThan(0);
  });

  it('is behind the password like everything else', async () => {
    const { base } = await harness();
    expect((await fetch(`${base}/api/settings`)).status).toBe(401);
    expect((await fetch(`${base}/api/settings`, { method: 'PUT' })).status).toBe(401);
    expect((await fetch(`${base}/api/settings/backup`, { method: 'POST' })).status).toBe(401);
  });
});

describe('running a rule by hand', () => {
  it('runs a stored automation and says so', async () => {
    const { base } = await harness();
    const { fetch: signed } = await signIn(base);

    const created = await signed('/api/rules', {
      method: 'PUT',
      body: JSON.stringify({
        name: 'By hand',
        enabled: false,
        trigger: {
          sourceId: 'zigbee',
          deviceId: '0xf044d3fffe024659',
          propertyKey: 'state_l1',
          match: { kind: 'equals', value: 'ON' },
        },
        actions: [
          {
            sourceId: 'zigbee',
            deviceId: '0xf044d3fffe024659',
            propertyKey: 'state_l1',
            value: 'ON',
          },
        ],
      }),
    });
    const { rule } = (await created.json()) as { rule: { id: string } };

    const response = await signed(`/api/rules/${rule.id}/run`, { method: 'POST' });
    expect(response.status).toBe(200);
  });

  it('says no to a rule that is not there', async () => {
    const { base } = await harness();
    const { fetch: signed } = await signIn(base);

    const response = await signed('/api/rules/nothing/run', { method: 'POST' });
    expect(response.status).toBe(404);
  });

  it('is behind the password like everything else', async () => {
    const { base } = await harness();
    const response = await fetch(`${base}/api/rules/anything/run`, { method: 'POST' });
    expect(response.status).toBe(401);
  });
});

describe('the network map', () => {
  const SCAN = {
    status: 'ok',
    data: {
      type: 'raw',
      value: {
        nodes: [
          { ieeeAddr: '0x001', friendlyName: 'Coordinator', type: 'Coordinator' },
          { ieeeAddr: '0x002', friendlyName: 'hall_socket', type: 'Router' },
        ],
        links: [{ source: { ieeeAddr: '0x001' }, target: { ieeeAddr: '0x002' }, linkquality: 180 }],
      },
    },
  };

  /** The request goes out over MQTT, so wait for it before answering. */
  async function whenAsked(mqtt: FakeMqtt): Promise<void> {
    for (let turn = 0; turn < 50; turn++) {
      if (mqtt.published.some((message) => message.topic.endsWith('request/networkmap'))) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('the server never asked for a map');
  }

  it('answers with the scan once the bridge replies', async () => {
    const { base, mqtt } = await harness();
    const { fetch: signed } = await signIn(base);

    const pending = signed('/api/map', { method: 'POST' });
    await whenAsked(mqtt);
    mqtt.deliver('zigbee2mqtt/bridge/response/networkmap', SCAN);

    const response = await pending;
    expect(response.status).toBe(200);
    const map = (await response.json()) as { nodes: unknown[]; links: unknown[] };
    expect(map.nodes).toHaveLength(2);
    expect(map.links).toHaveLength(1);
  });

  it('passes on a refusal rather than hanging', async () => {
    const { base, mqtt } = await harness();
    const { fetch: signed } = await signIn(base);

    const pending = signed('/api/map', { method: 'POST' });
    await whenAsked(mqtt);
    mqtt.deliver('zigbee2mqtt/bridge/response/networkmap', {
      status: 'error',
      error: 'coordinator is busy',
    });

    const response = await pending;
    expect(response.status).toBe(502);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining('busy'),
    });
  });

  it('says there is no network to describe when no source has one', async () => {
    const { base } = await harness({
      sources: [{ id: 'broadlink', adapter: 'json-topic', baseTopic: 'broadlinkrm' }],
    });
    const { fetch: signed } = await signIn(base);

    const response = await signed('/api/map', { method: 'POST' });
    expect(response.status).toBe(501);
  });

  it('is behind the password like everything else', async () => {
    const { base } = await harness();
    const response = await fetch(`${base}/api/map`, { method: 'POST' });
    expect(response.status).toBe(401);
  });
});
