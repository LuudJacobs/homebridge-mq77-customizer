import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Catalog } from '../src/catalog.js';
import { silentLogger } from '../src/logger.js';
import { RulesEngine } from '../src/rules/engine.js';
import type { Rule } from '../src/rules/types.js';
import { parseRule } from '../src/rules/validate.js';
import { Store } from '../src/store.js';
import fixture from './fixtures/bridge-devices.json' with { type: 'json' };
import { FakeMqtt } from './helpers/fake-mqtt.js';

const SOCKET = { id: '0x00158dfffe000006', topic: 'zigbee2mqtt/living_room_lamp-socket' };
const LAMP = { id: '0x00158dfffe000003', topic: 'zigbee2mqtt/kitchen_dimmer-candeo' };
const ref = (deviceId: string) => ({ sourceId: 'zigbee', deviceId, propertyKey: 'state' });

/** Lamp on when the socket comes on, unless the lamp is on already. */
const rule: Rule = {
  id: 'r1',
  name: 'Licht',
  enabled: true,
  rateLimitMs: 0,
  triggers: [{ ...ref(SOCKET.id), match: { kind: 'changedTo', value: 'ON' } }],
  branches: [
    {
      label: 'Al aan',
      when: { kind: 'test', ...ref(LAMP.id), match: { kind: 'equals', value: 'ON' } },
      actions: [{ kind: 'ignore' }],
    },
    { actions: [{ ...ref(LAMP.id), value: 'ON' }] },
  ],
} as Rule;

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'mq77-ignore-'));
  const store = new Store(join(directory, 'state.json'), silentLogger);
  await store.load();
  store.update((state) => {
    state.rules = [rule];
  });
  const mqtt = new FakeMqtt();
  const catalog = new Catalog(mqtt.asConnection(), silentLogger);
  await catalog.start([{ id: 'zigbee', adapter: 'zigbee2mqtt', baseTopic: 'zigbee2mqtt' }]);
  mqtt.deliver('zigbee2mqtt/bridge/devices', fixture, { retained: true });
  const engine = new RulesEngine(catalog, store, mqtt.asConnection(), silentLogger);
  catalog.on('state', (update) => engine.handleState(update));
  return { mqtt, engine };
}

describe('an outcome that ignores', () => {
  it('stops the rule there, sending nothing, and says it ignored', async () => {
    const { mqtt, engine } = await harness();
    mqtt.deliver(LAMP.topic, { state: 'ON' }, { retained: true });

    mqtt.deliver(SOCKET.topic, { state: 'ON' });

    expect(mqtt.published).toEqual([]);
    expect(engine.getLog()[0]).toMatchObject({
      outcome: 'fired',
      detail: 'ignored',
      branch: 'Al aan',
    });
  });

  it('lets the next outcome run when it does not hold', async () => {
    const { mqtt, engine } = await harness();
    mqtt.deliver(LAMP.topic, { state: 'OFF' }, { retained: true });

    mqtt.deliver(SOCKET.topic, { state: 'ON' });

    expect(mqtt.published.map((message) => message.topic)).toEqual([`${LAMP.topic}/set`]);
    expect(engine.getLog()[0]).toMatchObject({ outcome: 'fired', detail: '1 action sent' });
  });
});

describe('reading an outcome that ignores', () => {
  const trigger = { ...ref('0xa'), match: { kind: 'changedTo', value: 'ON' } };

  it('keeps it', () => {
    const parsed = parseRule({ name: 'Niets', trigger, actions: [{ kind: 'ignore' }] }, 'r1');
    expect('rule' in parsed && parsed.rule.branches?.[0]?.actions).toEqual([{ kind: 'ignore' }]);
  });

  it('refuses one with something else to do as well', () => {
    const parsed = parseRule(
      { name: 'Niets', trigger, actions: [{ kind: 'ignore' }, { ...ref('0xb'), value: 'ON' }] },
      'r1',
    );
    expect(parsed).toEqual({ error: 'An outcome that ignores does nothing else' });
  });
});
