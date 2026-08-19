import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Catalog } from '../src/catalog.js';
import { silentLogger } from '../src/logger.js';
import { RulesEngine } from '../src/rules/engine.js';
import { RUNAWAY_FIRINGS } from '../src/rules/types.js';

import { DEFAULT_SETTLE_MS } from '../src/rules/types.js';

const SETTLE_MS = DEFAULT_SETTLE_MS;
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
    vi.useFakeTimers();
    try {
      const { mqtt } = await harness([mirrorRule()]);

      mqtt.deliver(SWITCH.topic, { state_l1: 'ON' });
      expect(mqtt.published.at(-1)).toEqual({
        topic: `${SOCKET.topic}/set`,
        payload: '{"state":"ON"}',
        retain: false,
      });

      // The group is left to settle first. A change arriving within a few
      // seconds of a write cannot be told apart from the echo of that write.
      vi.advanceTimersByTime(SETTLE_MS + 100);

      mqtt.deliver(SOCKET.topic, { state: 'OFF' });
      expect(mqtt.published.at(-1)).toEqual({
        topic: `${SWITCH.topic}/set`,
        payload: '{"state_l1":"OFF"}',
        retain: false,
      });
    } finally {
      vi.useRealTimers();
    }
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
  it('cannot ping pong when two devices never agree', async () => {
    vi.useFakeTimers();
    try {
      const { store, mqtt } = await harness([mirrorRule()]);

      // Neither device ever takes the value it is sent, so each keeps
      // reporting the state the other one is trying to change. This is what
      // filled the log with "State copied to State" several times a second.
      for (let round = 0; round < 200; round++) {
        mqtt.deliver(SWITCH.topic, { state_l1: 'ON' });
        mqtt.deliver(SOCKET.topic, { state: 'OFF' });
        vi.advanceTimersByTime(50);
      }

      expect(store.data.rules[0]?.enabled).toBe(true);
      // Ten seconds of disagreement, at most one exchange per settling window.
      expect(mqtt.published.length).toBeLessThanOrEqual(10_000 / DEFAULT_SETTLE_MS + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still acts on a real change once the group has settled', async () => {
    vi.useFakeTimers();
    try {
      const { mqtt } = await harness([mirrorRule()]);

      mqtt.deliver(SWITCH.topic, { state_l1: 'ON' });
      expect(mqtt.published).toHaveLength(1);

      mqtt.deliver(SOCKET.topic, { state: 'ON' });
      vi.advanceTimersByTime(SETTLE_MS + 100);

      // Someone turns the socket off by hand, which the switch should follow.
      mqtt.deliver(SOCKET.topic, { state: 'OFF' });
      expect(mqtt.published.at(-1)).toEqual({
        topic: `${SWITCH.topic}/set`,
        payload: '{"state_l1":"OFF"}',
        retain: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

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

  it('tries again once the settling window has passed and it still disagrees', async () => {
    vi.useFakeTimers();
    try {
      const { mqtt } = await harness([mirrorRule()]);

      mqtt.deliver(SWITCH.topic, { state_l1: 'ON' });
      expect(mqtt.published).toHaveLength(1);

      vi.advanceTimersByTime(SETTLE_MS + 100);
      mqtt.deliver(SWITCH.topic, { state_l1: 'ON', linkquality: 55 });
      expect(mqtt.published).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the settling window', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('can be shortened per rule', async () => {
    const { mqtt } = await harness([mirrorRule({ settleMs: 500 })]);

    mqtt.deliver(SWITCH.topic, { state_l1: 'ON' });
    expect(mqtt.published).toHaveLength(1);

    vi.advanceTimersByTime(600);
    mqtt.deliver(SOCKET.topic, { state: 'OFF' });
    // Would still be settling under the default.
    expect(mqtt.published).toHaveLength(2);
  });

  it('can be lengthened per rule', async () => {
    const { mqtt } = await harness([mirrorRule({ settleMs: 10_000 })]);

    mqtt.deliver(SWITCH.topic, { state_l1: 'ON' });
    vi.advanceTimersByTime(DEFAULT_SETTLE_MS + 100);
    mqtt.deliver(SOCKET.topic, { state: 'OFF' });
    expect(mqtt.published).toHaveLength(1);

    vi.advanceTimersByTime(10_000);
    mqtt.deliver(SOCKET.topic, { state: 'OFF' });
    expect(mqtt.published).toHaveLength(2);
  });
});

describe('parsing a mirror rule', () => {
  const group = [
    { sourceId: 'z', deviceId: 'a', propertyKey: 'state' },
    { sourceId: 'z', deviceId: 'b', propertyKey: 'state_l1' },
  ];

  it('keeps the settling window within something workable', () => {
    // Below the floor two devices that disagree could trade places fast
    // enough to look like the runaway this window exists to prevent.
    const short = parseRule({ kind: 'mirror', name: 'x', groups: [group], settleMs: 10 }, 'm1');
    expect('rule' in short && short.rule.settleMs).toBe(250);

    const long = parseRule({ kind: 'mirror', name: 'x', groups: [group], settleMs: 999_999 }, 'm1');
    expect('rule' in long && long.rule.settleMs).toBe(60_000);
  });

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
