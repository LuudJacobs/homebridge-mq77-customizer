import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { Catalog } from '../src/catalog.js';
import { silentLogger } from '../src/logger.js';
import { RulesEngine } from '../src/rules/engine.js';
import { ntfy, type Notifier } from '../src/rules/ntfy.js';
import type { Rule } from '../src/rules/types.js';
import { parseRule } from '../src/rules/validate.js';
import { Store } from '../src/store.js';
import fixture from './fixtures/bridge-devices.json' with { type: 'json' };
import { FakeMqtt } from './helpers/fake-mqtt.js';

const SOCKET = { id: '0x00158dfffe000006', topic: 'zigbee2mqtt/living_room_lamp-socket' };
const CLIMATE = { id: '0x00158dfffe000004', topic: 'zigbee2mqtt/living_room_climate-w100' };
const LAMP = { id: '0x00158dfffe000003', topic: 'zigbee2mqtt/kitchen_dimmer-candeo' };

const ref = (deviceId: string, propertyKey: string) => ({
  sourceId: 'zigbee',
  deviceId,
  propertyKey,
});

/** Remembers what it was asked to send, instead of sending it. */
function outbox(): Notifier & { sent: { title?: string; message: string }[] } {
  const sent: { title?: string; message: string }[] = [];
  return {
    sent,
    async send(title, message) {
      sent.push({ ...(title ? { title } : {}), message });
    },
  };
}

function telling(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 'r1',
    name: 'Stopcontact',
    enabled: true,
    triggers: [{ ...ref(SOCKET.id, 'state'), match: { kind: 'changedTo', value: 'ON' } }],
    branches: [
      {
        actions: [
          { kind: 'notify', title: 'Let op', message: '<rule>: <trigger> <property> is <value>' },
        ],
      },
    ],
    rateLimitMs: 0,
    ...overrides,
  } as Rule;
}

async function harness(rules: Rule[], notifier?: Notifier, exposures: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mq77-notify-'));
  const store = new Store(join(directory, 'state.json'), silentLogger);
  await store.load();
  store.update((state) => {
    state.rules = rules;
    state.exposures = exposures as never;
  });

  const mqtt = new FakeMqtt();
  const catalog = new Catalog(mqtt.asConnection(), silentLogger);
  await catalog.start([{ id: 'zigbee', adapter: 'zigbee2mqtt', baseTopic: 'zigbee2mqtt' }]);
  mqtt.deliver('zigbee2mqtt/bridge/devices', fixture, { retained: true });

  const engine = new RulesEngine(
    catalog,
    store,
    mqtt.asConnection(),
    silentLogger,
    undefined,
    notifier,
  );
  catalog.on('state', (update) => engine.handleState(update));
  return { engine, mqtt };
}

describe('a notification as an action', () => {
  it('sends the title and the message, with what set it off written in', async () => {
    const box = outbox();
    const { mqtt } = await harness([telling()], box, {
      [`zigbee:${SOCKET.id}`]: { properties: [], room: 'Woonkamer', label: 'Stopcontact' },
    });

    mqtt.deliver(SOCKET.topic, { state: 'ON' });
    await Promise.resolve();

    expect(box.sent).toEqual([
      { title: 'Let op', message: 'Stopcontact: Woonkamer Stopcontact State is ON' },
    ]);
  });

  it('names a device nobody has named by what its source calls it', async () => {
    const box = outbox();
    const { mqtt } = await harness(
      [telling({ branches: [{ actions: [{ kind: 'notify', message: '<trigger>' }] }] })],
      box,
    );

    mqtt.deliver(SOCKET.topic, { state: 'ON' });
    await Promise.resolve();

    expect(box.sent).toEqual([{ message: 'living_room_lamp-socket' }]);
  });

  it('puts the unit against a number', async () => {
    const box = outbox();
    const warm = telling({
      triggers: [{ ...ref(CLIMATE.id, 'temperature'), match: { kind: 'above', value: 25 } }],
      branches: [{ actions: [{ kind: 'notify', message: '<property>: <value>' }] }],
    });
    const { mqtt } = await harness([warm], box);

    mqtt.deliver(CLIMATE.topic, { temperature: 26.5 });
    await Promise.resolve();

    expect(box.sent[0]?.message).toBe('Temperature: 26.5°C');
  });

  it('says the time when the clock set it off, and nothing for what a clock has not got', async () => {
    const box = outbox();
    const evening = telling({
      triggers: [{ kind: 'time', at: '22:00' }],
      branches: [{ actions: [{ kind: 'notify', message: '<trigger> <property><value>!' }] }],
    });
    const { engine } = await harness([evening], box);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-03-10T22:00:05'));
      engine.readClock(new Date());
    } finally {
      vi.useRealTimers();
    }
    await Promise.resolve();

    expect(box.sent[0]?.message).toBe('22:00 !');
  });

  it('sends alongside the rule’s other actions, and counts as one of them', async () => {
    const box = outbox();
    const both = telling({
      branches: [
        {
          actions: [
            { ...ref(LAMP.id, 'state'), value: 'ON' },
            { kind: 'notify', message: 'Licht aan' },
          ],
        },
      ],
    });
    const { engine, mqtt } = await harness([both], box);
    mqtt.deliver(SOCKET.topic, { state: 'ON' });
    await Promise.resolve();

    expect(mqtt.published.map((message) => message.payload)).toContain('{"state":"ON"}');
    expect(box.sent).toEqual([{ message: 'Licht aan' }]);
    expect(engine.getLog()[0]).toMatchObject({ outcome: 'fired', detail: '2 actions sent' });
  });

  it('fails out loud when no topic is set', async () => {
    const { engine, mqtt } = await harness([telling()]);
    mqtt.deliver(SOCKET.topic, { state: 'ON' });

    expect(engine.getLog()[0]).toMatchObject({ outcome: 'failed' });
    expect(engine.getLog()[0]?.detail).toContain('no ntfy topic');
  });

  it('says so when ntfy turns it down', async () => {
    const refusing: Notifier = { send: () => Promise.reject(new Error('ntfy answered 429')) };
    const { engine, mqtt } = await harness([telling()], refusing);

    mqtt.deliver(SOCKET.topic, { state: 'ON' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(engine.getLog()[0]).toMatchObject({ outcome: 'failed' });
    expect(engine.getLog()[0]?.detail).toContain('ntfy answered 429');
  });
});

describe('talking to ntfy', () => {
  it('publishes JSON to ntfy.sh, which keeps a title in any language intact', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await ntfy('huis-mq77', fetcher).send('Rook! 🔥', 'Gang Rookmelder ziet rook');

    expect(calls[0]?.url).toBe('https://ntfy.sh');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      topic: 'huis-mq77',
      title: 'Rook! 🔥',
      message: 'Gang Rookmelder ziet rook',
    });
  });

  it('turns a refusal into an error', async () => {
    const fetcher = (async () => new Response('nope', { status: 429 })) as unknown as typeof fetch;
    await expect(ntfy('t', fetcher).send(undefined, 'x')).rejects.toThrow('429');
  });
});

describe('reading a notification in a rule', () => {
  const trigger = {
    sourceId: 'zigbee',
    deviceId: '0xa',
    propertyKey: 'state',
    match: { kind: 'changedTo', value: 'ON' },
  };

  it('keeps the title, the message and the delay', () => {
    const parsed = parseRule(
      {
        name: 'Zeg het',
        trigger,
        actions: [{ kind: 'notify', title: ' Let op ', message: ' <trigger> ', delayMs: 5000 }],
      },
      'r1',
    );
    expect('rule' in parsed && parsed.rule.branches?.[0]?.actions[0]).toEqual({
      kind: 'notify',
      title: 'Let op',
      message: '<trigger>',
      delayMs: 5000,
    });
  });

  it('refuses one with nothing to say', () => {
    const parsed = parseRule(
      { name: 'Stil', trigger, actions: [{ kind: 'notify', title: 'Leeg', message: '  ' }] },
      'r1',
    );
    expect(parsed).toMatchObject({ error: 'A notification needs a message' });
  });
});
