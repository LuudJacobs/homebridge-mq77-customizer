import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Catalog } from '../src/catalog.js';
import { silentLogger, type Logger } from '../src/logger.js';
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
}

async function harness(options: { password?: string } = {}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'mqtt-customizer-web-'));
  const store = new Store(join(directory, 'state.json'), silentLogger);
  await store.load();

  const mqtt = new FakeMqtt();
  const catalog = new Catalog(mqtt.asConnection(), silentLogger);
  await catalog.start([{ id: 'zigbee', adapter: 'zigbee2mqtt', baseTopic: 'zigbee2mqtt' }]);
  mqtt.deliver('zigbee2mqtt/bridge/devices', fixture, { retained: true });
  mqtt.deliver('zigbee2mqtt/woonkamer_lampen-ZB2GS', { state_l1: 'ON', state_l2: 'OFF' });

  const result: Harness = { server: undefined as never, store, base: '', syncs: 0 };

  const server = new WebServer({
    config: { port: 0, password: options.password ?? PASSWORD },
    catalog,
    store,
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
    expect(await response.text()).toContain('MQTT Customizer');
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
    const directory = await mkdtemp(join(tmpdir(), 'mqtt-customizer-web-'));
    const store = new Store(join(directory, 'state.json'), silentLogger);
    await store.load();
    const mqtt = new FakeMqtt();
    const catalog = new Catalog(mqtt.asConnection(), silentLogger);

    const server = new WebServer({
      config: { port: 0 },
      catalog,
      store,
      log,
      onExposureChanged: () => {},
    });
    await server.start();

    expect(messages.join(' ')).toContain('No web password set');
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
    });
    expect(sanitiseExposure({ properties: 'nope' }, known).properties).toEqual([]);
  });
});
