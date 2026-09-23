import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BatteryWatch, readBattery, stageOf } from '../src/battery.js';
import { Catalog } from '../src/catalog.js';
import { silentLogger } from '../src/logger.js';
import type { Notifier } from '../src/rules/ntfy.js';
import { Store } from '../src/store.js';
import { sanitiseExposure } from '../src/web/server.js';
import fixture from './fixtures/bridge-devices.json' with { type: 'json' };
import { FakeMqtt } from './helpers/fake-mqtt.js';

/** The thermostat, which counts its battery. */
const CLIMATE = { id: '0x00158dfffe000004', topic: 'zigbee2mqtt/living_room_climate-w100' };

function outbox(): Notifier & { sent: { title?: string; message: string }[] } {
  const sent: { title?: string; message: string }[] = [];
  return {
    sent,
    async send(title, message) {
      sent.push({ ...(title ? { title } : {}), message });
    },
  };
}

async function harness(exposures: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mq77-battery-'));
  const store = new Store(join(directory, 'state.json'), silentLogger);
  await store.load();
  store.update((state) => {
    state.exposures = exposures as never;
  });

  const mqtt = new FakeMqtt();
  const catalog = new Catalog(mqtt.asConnection(), silentLogger);
  await catalog.start([{ id: 'zigbee', adapter: 'zigbee2mqtt', baseTopic: 'zigbee2mqtt' }]);
  mqtt.deliver('zigbee2mqtt/bridge/devices', fixture, { retained: true });

  const box = outbox();
  const watch = new BatteryWatch(catalog, store, box, silentLogger);
  catalog.on('state', (update) => watch.handleState(update));
  return { mqtt, box };
}

describe('what counts as low', () => {
  it('reads a percentage under ten, or either flag', () => {
    expect(readBattery({ battery: 9 }).low).toBe(true);
    expect(readBattery({ battery: 10 }).low).toBe(false);
    expect(readBattery({ battery_low: true }).low).toBe(true);
    expect(readBattery({ low_battery: true }).low).toBe(true);
    expect(readBattery({ battery_low: false, battery: 80 }).low).toBe(false);
    expect(readBattery({}).low).toBe(false);
  });

  it('steps down at ten, at five and at one', () => {
    expect(stageOf(readBattery({ battery: 50 }))).toBe(0);
    expect(stageOf(readBattery({ battery: 9 }))).toBe(1);
    expect(stageOf(readBattery({ battery: 5 }))).toBe(2);
    expect(stageOf(readBattery({ battery: 1 }))).toBe(3);
    // A flag has nothing to count down.
    expect(stageOf(readBattery({ battery_low: true }))).toBe(1);
  });
});

describe('warning about it', () => {
  it('says so once below ten, named the way the device is named here', async () => {
    const { mqtt, box } = await harness({
      [`zigbee:${CLIMATE.id}`]: { properties: [], room: 'Woonkamer', label: 'Thermostaat' },
    });

    mqtt.deliver(CLIMATE.topic, { battery: 12 });
    mqtt.deliver(CLIMATE.topic, { battery: 8 });
    mqtt.deliver(CLIMATE.topic, { battery: 7 });
    await Promise.resolve();

    expect(box.sent).toEqual([
      {
        title: 'Woonkamer Thermostaat is low on battery',
        message: 'Battery for Woonkamer Thermostaat is at 8%.',
      },
    ]);
  });

  it('says so again at five and at one, and not in between', async () => {
    const { mqtt, box } = await harness();
    for (const battery of [9, 6, 5, 4, 2, 1, 1]) {
      mqtt.deliver(CLIMATE.topic, { battery });
    }
    await Promise.resolve();

    expect(box.sent.map((sent) => sent.message)).toEqual([
      'Battery for Living room thermostat is at 9%.',
      'Battery for Living room thermostat is at 5%.',
      'Battery for Living room thermostat is at 1%.',
    ]);
  });

  it('says once that a flag is up, with no number to give', async () => {
    // Nothing in the fixture raises a flag, so a catalog that only knows one
    // device saying one thing stands in for it.
    const said: Record<string, unknown> = {};
    const catalog = {
      getState: () => said,
      getDevice: () => ({ name: 'Gang Beweging' }),
    } as unknown as Catalog;
    const directory = await mkdtemp(join(tmpdir(), 'mq77-battery-'));
    const store = new Store(join(directory, 'state.json'), silentLogger);
    await store.load();
    const box = outbox();
    const watch = new BatteryWatch(catalog, store, box, silentLogger);

    const report = (changes: Record<string, unknown>) => {
      Object.assign(said, changes);
      watch.handleState({ sourceId: 'zigbee', deviceId: '0xe1', changes, at: Date.now() });
    };
    report({ battery_low: true });
    report({ battery_low: true });
    await Promise.resolve();

    expect(box.sent).toEqual([
      { title: 'Gang Beweging is low on battery', message: 'Battery for Gang Beweging is low.' },
    ]);
  });

  it('warns again once a new battery has run low in its turn', async () => {
    const { mqtt, box } = await harness();
    mqtt.deliver(CLIMATE.topic, { battery: 8 });
    // Replaced.
    mqtt.deliver(CLIMATE.topic, { battery: 100 });
    mqtt.deliver(CLIMATE.topic, { battery: 9 });
    await Promise.resolve();

    expect(box.sent).toHaveLength(2);
  });

  it('counts what the broker replays on connect, since that is how a restart hears of it', async () => {
    const { mqtt, box } = await harness();
    mqtt.deliver(CLIMATE.topic, { battery: 4 }, { retained: true });
    await Promise.resolve();

    // One warning for where it is now, not three for the steps it passed.
    expect(box.sent).toEqual([
      {
        title: 'Living room thermostat is low on battery',
        message: 'Battery for Living room thermostat is at 4%.',
      },
    ]);
  });

  it('keeps quiet for a device it was told not to warn about', async () => {
    const { mqtt, box } = await harness({
      [`zigbee:${CLIMATE.id}`]: { properties: [], batteryWarning: false },
    });
    mqtt.deliver(CLIMATE.topic, { battery: 3 });
    await Promise.resolve();
    expect(box.sent).toEqual([]);
  });

  it('pays no attention to a message about something else', async () => {
    const { mqtt, box } = await harness();
    mqtt.deliver(CLIMATE.topic, { battery: 8 });
    mqtt.deliver(CLIMATE.topic, { temperature: 21 });
    await Promise.resolve();
    expect(box.sent).toHaveLength(1);
  });
});

describe('the setting', () => {
  it('keeps only the off, since on is what absent means', () => {
    expect(sanitiseExposure({ properties: [], batteryWarning: false }, []).batteryWarning).toBe(false);
    expect(sanitiseExposure({ properties: [], batteryWarning: true }, [])).not.toHaveProperty(
      'batteryWarning',
    );
    expect(sanitiseExposure({ properties: [] }, [])).not.toHaveProperty('batteryWarning');
  });
});
