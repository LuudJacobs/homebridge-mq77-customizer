import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Catalog } from '../src/catalog.js';
import { silentLogger } from '../src/logger.js';
import { RulesEngine } from '../src/rules/engine.js';
import { Store } from '../src/store.js';
import { WebServer } from '../src/web/server.js';
import fixture from './fixtures/bridge-devices.json' with { type: 'json' };
import { FakeMqtt } from './helpers/fake-mqtt.js';

const SOCKET = '0x00158dfffe000006';

describe('forgetting a device', () => {
  let server: WebServer | undefined;
  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  async function serve() {
    const directory = await mkdtemp(join(tmpdir(), 'mq77-forget-'));
    const store = new Store(join(directory, 'state.json'), silentLogger);
    await store.load();
    const mqtt = new FakeMqtt();
    const catalog = new Catalog(mqtt.asConnection(), silentLogger);
    await catalog.start([
      { id: 'zigbee', adapter: 'zigbee2mqtt', baseTopic: 'zigbee2mqtt' },
      { id: 'tasmota', adapter: 'json-topic', baseTopic: 'tele' },
    ]);
    mqtt.deliver('zigbee2mqtt/bridge/devices', fixture, { retained: true });
    mqtt.deliver('tele/garage', { temperature: 12 });
    let syncs = 0;
    server = new WebServer({
      config: { port: 0, password: 'pw' },
      catalog,
      store,
      rules: new RulesEngine(catalog, store, mqtt.asConnection(), silentLogger),
      log: silentLogger,
      onExposureChanged: () => {
        syncs += 1;
      },
    });
    await server.start();
    const base = `http://127.0.0.1:${server.port}`;
    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'pw' }),
    });
    const cookie = login.headers.getSetCookie()[0]?.split(';')[0] ?? '';
    const forget = (sourceId: string, deviceId: string) =>
      fetch(`${base}/api/devices`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ sourceId, deviceId }),
      });
    return { store, catalog, mqtt, forget, syncs: () => syncs };
  }

  it('drops what was set for it, and its tiles with it', async () => {
    const { store, forget, syncs } = await serve();
    store.setExposure(`zigbee:${SOCKET}`, { properties: ['state'], room: 'Gang', label: 'Lamp' });

    expect((await forget('zigbee', SOCKET)).status).toBe(200);
    expect(store.getExposure(`zigbee:${SOCKET}`)).toBeUndefined();
    expect(syncs()).toBe(1);
  });

  it('leaves one Zigbee2MQTT still lists in the list, as new', async () => {
    const { catalog, forget } = await serve();
    await forget('zigbee', SOCKET);
    expect(catalog.getDevice('zigbee', SOCKET)).toBeDefined();
  });

  it('drops a JSON topic until it says something again', async () => {
    const { catalog, mqtt, forget } = await serve();
    expect(catalog.getDevice('tasmota', 'garage')).toBeDefined();

    await forget('tasmota', 'garage');
    expect(catalog.getDevice('tasmota', 'garage')).toBeUndefined();

    mqtt.deliver('tele/garage', { temperature: 13 });
    expect(catalog.getDevice('tasmota', 'garage')).toBeDefined();
  });
});
