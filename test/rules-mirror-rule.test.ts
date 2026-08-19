import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Catalog } from '../src/catalog.js';
import { silentLogger } from '../src/logger.js';
import { RulesEngine } from '../src/rules/engine.js';
import { RUNAWAY_FIRINGS } from '../src/rules/types.js';
import type { MirrorRule } from '../src/rules/types.js';
import { parseRule } from '../src/rules/validate.js';
import { Store } from '../src/store.js';
import fixture from './fixtures/bridge-devices.json' with { type: 'json' };
import { FakeMqtt } from './helpers/fake-mqtt.js';

const SWITCH = { id: '0xf044d3fffe024659', topic: 'zigbee2mqtt/woonkamer_lampen-ZB2GS' };
const SOCKET = { id: '0xa4c138ae47fdd9c3', topic: 'zigbee2mqtt/woonkamer_bank_lamp-socket' };

function mirrorRule(overrides: Partial<MirrorRule> = {}): MirrorRule {
  return {
    id: 'm1',
    kind: 'mirror',
    name: 'Socket and wall switch together',
    enabled: true,
    groups: [
      [
        { sourceId: 'zigbee', deviceId: SWITCH.id, propertyKey: 'state_l1' },
        { sourceId: 'zigbee', deviceId: SOCKET.id, propertyKey: 'state' },
      ],
    ],
    ...overrides,
  };
}

async function harness(rules: MirrorRule[]) {
  const directory = await mkdtemp(join(tmpdir(), 'mq77-mirrorrule-'));
  const store = new Store(join(directory, 'state.json'), silentLogger);
  await store.load();
  store.update((state) => {
    state.rules = rules;
  });

  const mqtt = new FakeMqtt();
  const catalog = new Catalog(mqtt.asConnection(), silentLogger);
  await catalog.start([{ id: 'zigbee', adapter: 'zigbee2mqtt', baseTopic: 'zigbee2mqtt' }]);
  mqtt.deliver('zigbee2mqtt/bridge/devices', fixture, { retained: true });

  const engine = new RulesEngine(catalog, store, mqtt.asConnection(), silentLogger);
  catalog.on('state', (update) => engine.handleState(update));
  return { engine, store, mqtt };
}

describe('mirroring', () => {
  it('copies in either direction', async () => {
    const { mqtt } = await harness([mirrorRule()]);

    mqtt.deliver(SWITCH.topic, { state_l1: 'ON' });
    expect(mqtt.published.at(-1)).toEqual({
      topic: `${SOCKET.topic}/set`,
      payload: '{"state":"ON"}',
      retain: false,
    });

    mqtt.deliver(SOCKET.topic, { state: 'OFF' });
    expect(mqtt.published.at(-1)).toEqual({
      topic: `${SWITCH.topic}/set`,
      payload: '{"state_l1":"OFF"}',
      retain: false,
    });
  });

  it('settles instead of looping when the other device reports back', async () => {
    const { mqtt } = await harness([mirrorRule()]);

    mqtt.deliver(SWITCH.topic, { state_l1: 'ON' });
    expect(mqtt.published).toHaveLength(1);

    // The socket now confirms it is on, which mirrors again. The switch is
    // already on, so there is nothing to send and it stops here.
    mqtt.deliver(SOCKET.topic, { state: 'ON' });
    expect(mqtt.published).toHaveLength(1);
  });

  it('leaves a device that already holds the value alone', async () => {
    const { mqtt } = await harness([mirrorRule()]);
    mqtt.deliver(SOCKET.topic, { state: 'ON' });
    mqtt.published.length = 0;

    mqtt.deliver(SWITCH.topic, { state_l1: 'ON' });
    expect(mqtt.published).toEqual([]);
  });

  it('never acts on retained state replayed at startup', async () => {
    const { mqtt } = await harness([mirrorRule()]);
    mqtt.deliver(SWITCH.topic, { state_l1: 'ON' }, { retained: true });
    expect(mqtt.published).toEqual([]);
  });

  it('mirrors several devices from one change', async () => {
    const rule = mirrorRule({
      groups: [
        [
          { sourceId: 'zigbee', deviceId: SWITCH.id, propertyKey: 'state_l1' },
          { sourceId: 'zigbee', deviceId: SWITCH.id, propertyKey: 'state_l2' },
          { sourceId: 'zigbee', deviceId: SOCKET.id, propertyKey: 'state' },
        ],
      ],
    });
    const { mqtt } = await harness([rule]);

    mqtt.deliver(SWITCH.topic, { state_l1: 'ON' });
    expect(mqtt.published.map((entry) => entry.payload).sort()).toEqual([
      '{"state":"ON"}',
      '{"state_l2":"ON"}',
    ]);
  });

  it('keeps groups independent', async () => {
    const rule = mirrorRule({
      groups: [
        [
          { sourceId: 'zigbee', deviceId: SWITCH.id, propertyKey: 'state_l1' },
          { sourceId: 'zigbee', deviceId: SOCKET.id, propertyKey: 'state' },
        ],
        [
          { sourceId: 'zigbee', deviceId: SWITCH.id, propertyKey: 'state_l2' },
          { sourceId: 'zigbee', deviceId: SOCKET.id, propertyKey: 'child_lock' },
        ],
      ],
    });
    const { mqtt } = await harness([rule]);

    mqtt.deliver(SWITCH.topic, { state_l2: 'ON' });
    // Only the second group moves, and the lock speaks its own words.
    expect(mqtt.published).toEqual([
      { topic: `${SOCKET.topic}/set`, payload: '{"child_lock":"LOCK"}', retain: false },
    ]);
  });

  it('says nothing when the change is not part of the rule', async () => {
    const { engine, mqtt } = await harness([mirrorRule()]);
    mqtt.deliver(SWITCH.topic, { linkquality: 90 });
    expect(mqtt.published).toEqual([]);
    expect(engine.getLog()).toEqual([]);
  });

  it('is skipped while disabled', async () => {
    const { mqtt } = await harness([mirrorRule({ enabled: false })]);
    mqtt.deliver(SWITCH.topic, { state_l1: 'ON' });
    expect(mqtt.published).toEqual([]);
  });
});

describe('not wearing itself out', () => {
  it('sends one write while the device is still acting on the last one', async () => {
    const { mqtt } = await harness([mirrorRule()]);

    mqtt.deliver(SWITCH.topic, { state_l1: 'ON' });
    expect(mqtt.published).toHaveLength(1);

    // Zigbee2MQTT republishes full state constantly, and with last_seen on it
    // does so on a timer. The socket has not confirmed yet, but it is already
    // on its way, so none of these should send anything further.
    for (let repeat = 0; repeat < 30; repeat++) {
      mqtt.deliver(SWITCH.topic, { state_l1: 'ON', linkquality: 60 + repeat });
    }
    expect(mqtt.published).toHaveLength(1);
  });

  it('survives far more traffic than the runaway guard allows', async () => {
    const { store, mqtt } = await harness([mirrorRule()]);

    for (let repeat = 0; repeat < RUNAWAY_FIRINGS * 3; repeat++) {
      mqtt.deliver(SWITCH.topic, { state_l1: 'ON', linkquality: repeat });
      mqtt.deliver(SOCKET.topic, { state: 'ON', power: repeat });
    }

    // A working mirror must not retire itself just because its devices are
    // chatty.
    expect(store.data.rules[0]?.enabled).toBe(true);
    expect(mqtt.published).toHaveLength(1);
  });

  it('counts one firing per change, not one per device written', async () => {
    const rule = mirrorRule({
      groups: [
        [
          { sourceId: 'zigbee', deviceId: SWITCH.id, propertyKey: 'state_l1' },
          { sourceId: 'zigbee', deviceId: SWITCH.id, propertyKey: 'state_l2' },
          { sourceId: 'zigbee', deviceId: SOCKET.id, propertyKey: 'state' },
        ],
      ],
    });
    const { store, mqtt } = await harness([rule]);

    // Alternating, so every change is genuine and nothing is already settled.
    for (let repeat = 0; repeat < RUNAWAY_FIRINGS - 1; repeat++) {
      mqtt.deliver(SWITCH.topic, { state_l1: repeat % 2 === 0 ? 'ON' : 'OFF' });
    }
    expect(store.data.rules[0]?.enabled).toBe(true);
  });

  it('writes again once the device has had its chance and did not comply', async () => {
    vi.useFakeTimers();
    try {
      const { mqtt } = await harness([mirrorRule()]);

      mqtt.deliver(SWITCH.topic, { state_l1: 'ON' });
      expect(mqtt.published).toHaveLength(1);

      // Long enough that the write is no longer plausibly on its way.
      vi.advanceTimersByTime(20_000);
      mqtt.deliver(SWITCH.topic, { state_l1: 'ON', linkquality: 55 });
      expect(mqtt.published).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops waiting as soon as the device answers', async () => {
    const { mqtt } = await harness([mirrorRule()]);

    mqtt.deliver(SWITCH.topic, { state_l1: 'ON' });
    // The socket says it went off instead, so the next change is not settled.
    mqtt.deliver(SOCKET.topic, { state: 'OFF' });
    expect(mqtt.published).toHaveLength(2);
    expect(mqtt.published.at(-1)?.payload).toBe('{"state_l1":"OFF"}');
  });
});

describe('parsing a mirror rule', () => {
  const group = [
    { sourceId: 'z', deviceId: 'a', propertyKey: 'state' },
    { sourceId: 'z', deviceId: 'b', propertyKey: 'state_l1' },
  ];

  it('accepts one', () => {
    const parsed = parseRule({ kind: 'mirror', name: 'Together', groups: [group] }, 'm1');
    expect('rule' in parsed && parsed.rule).toMatchObject({ kind: 'mirror', enabled: true });
  });

  it('needs two devices to mirror between', () => {
    expect(parseRule({ kind: 'mirror', name: 'x', groups: [[group[0]]] }, 'm1')).toEqual({
      error: 'Mirroring needs at least two devices',
    });
  });

  it('needs something to mirror', () => {
    expect(parseRule({ kind: 'mirror', name: 'x', groups: [] }, 'm1')).toEqual({
      error: 'Pick at least one function to mirror',
    });
  });

  it('refuses a function mirrored with itself', () => {
    expect(
      parseRule({ kind: 'mirror', name: 'x', groups: [[group[0], group[0]]] }, 'm1'),
    ).toEqual({ error: 'A function cannot be mirrored with itself' });
  });
});
