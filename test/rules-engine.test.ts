import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Catalog } from '../src/catalog.js';
import { silentLogger } from '../src/logger.js';
import { RulesEngine } from '../src/rules/engine.js';
import { RUNAWAY_FIRINGS, type Rule } from '../src/rules/types.js';
import { Store } from '../src/store.js';
import fixture from './fixtures/bridge-devices.json' with { type: 'json' };
import { FakeMqtt } from './helpers/fake-mqtt.js';

const ROCKER = { id: '0x54ef44100169b28a', topic: 'zigbee2mqtt/slaapkamer_schakelaar-wrs02' };
const SWITCH = { id: '0xf044d3fffe024659', topic: 'zigbee2mqtt/woonkamer_lampen-ZB2GS' };
const SOCKET = { id: '0xa4c138ae47fdd9c3', topic: 'zigbee2mqtt/woonkamer_bank_lamp-socket' };

interface Harness {
  engine: RulesEngine;
  store: Store;
  mqtt: FakeMqtt;
  catalog: Catalog;
}

async function harness(rules: Rule[] = []): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'mq77-rules-'));
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
  return { engine, store, mqtt, catalog };
}

/** Press the rocker's left button and turn on the living room light. */
function buttonRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 'r1',
    name: 'Left button turns the lamp on',
    enabled: true,
    trigger: {
      sourceId: 'zigbee',
      deviceId: ROCKER.id,
      propertyKey: 'action',
      match: { kind: 'equals', value: 'single_left' },
    },
    conditions: [],
    actions: [
      { sourceId: 'zigbee', deviceId: SWITCH.id, propertyKey: 'state_l1', value: 'ON' },
    ],
    rateLimitMs: 0,
    ...overrides,
  };
}

describe('firing', () => {
  it('publishes the action when the trigger matches', async () => {
    const { mqtt } = await harness([buttonRule()]);
    mqtt.deliver(ROCKER.topic, { action: 'single_left' });

    expect(mqtt.published).toEqual([
      { topic: `${SWITCH.topic}/set`, payload: '{"state_l1":"ON"}', retain: false },
    ]);
  });

  it('ignores a different value on the same property', async () => {
    const { mqtt } = await harness([buttonRule()]);
    mqtt.deliver(ROCKER.topic, { action: 'single_right' });
    expect(mqtt.published).toEqual([]);
  });

  it('ignores a disabled rule', async () => {
    const { mqtt } = await harness([buttonRule({ enabled: false })]);
    mqtt.deliver(ROCKER.topic, { action: 'single_left' });
    expect(mqtt.published).toEqual([]);
  });

  it('sends every action', async () => {
    const rule = buttonRule({
      actions: [
        { sourceId: 'zigbee', deviceId: SWITCH.id, propertyKey: 'state_l1', value: 'ON' },
        { sourceId: 'zigbee', deviceId: SWITCH.id, propertyKey: 'state_l2', value: 'OFF' },
      ],
    });
    const { mqtt } = await harness([rule]);
    mqtt.deliver(ROCKER.topic, { action: 'single_left' });
    expect(mqtt.published).toHaveLength(2);
  });

  it('works across sources, which is the point of the shared model', async () => {
    // The trigger is Zigbee, the target is a socket. Neither knows about the
    // other, they only share the normalised model.
    const rule = buttonRule({
      actions: [
        { sourceId: 'zigbee', deviceId: SOCKET.id, propertyKey: 'state', value: 'OFF' },
      ],
    });
    const { mqtt } = await harness([rule]);
    mqtt.deliver(ROCKER.topic, { action: 'single_left' });
    expect(mqtt.published[0]?.topic).toBe(`${SOCKET.topic}/set`);
  });
});

describe('several triggers', () => {
  const eitherButton = (): Rule => ({
    ...buttonRule(),
    trigger: undefined as never,
    triggers: [
      {
        sourceId: 'zigbee',
        deviceId: ROCKER.id,
        propertyKey: 'action',
        match: { kind: 'equals', value: 'single_left' },
      },
      {
        sourceId: 'zigbee',
        deviceId: SWITCH.id,
        propertyKey: 'state_l2',
        match: { kind: 'changedTo', value: 'ON' },
      },
    ],
  });

  it('fires on the first one', async () => {
    const { mqtt } = await harness([eitherButton()]);
    mqtt.deliver(ROCKER.topic, { action: 'single_left' });
    expect(mqtt.published).toHaveLength(1);
  });

  it('fires on the second one just as well', async () => {
    const { mqtt } = await harness([eitherButton()]);
    mqtt.deliver(SWITCH.topic, { state_l2: 'ON' });
    expect(mqtt.published).toHaveLength(1);
  });

  it('ignores anything that matches neither', async () => {
    const { mqtt } = await harness([eitherButton()]);
    mqtt.deliver(ROCKER.topic, { action: 'single_right' });
    mqtt.deliver(SWITCH.topic, { state_l2: 'OFF' });
    expect(mqtt.published).toEqual([]);
  });

  it('runs once when one message satisfies two of them', async () => {
    const rule = eitherButton();
    rule.triggers = [
      { sourceId: 'zigbee', deviceId: SWITCH.id, propertyKey: 'state_l1', match: { kind: 'changed' } },
      { sourceId: 'zigbee', deviceId: SWITCH.id, propertyKey: 'state_l2', match: { kind: 'changed' } },
    ];
    const { mqtt } = await harness([rule]);

    // Both channels in one message is still one thing happening.
    mqtt.deliver(SWITCH.topic, { state_l1: 'ON', state_l2: 'ON' });
    expect(mqtt.published).toHaveLength(1);
  });

  it('still reads a rule stored with a single trigger', async () => {
    const { mqtt } = await harness([buttonRule()]);
    mqtt.deliver(ROCKER.topic, { action: 'single_left' });
    expect(mqtt.published).toHaveLength(1);
  });

  it('copies the value from whichever trigger fired', async () => {
    const rule: Rule = {
      ...eitherButton(),
      actions: [
        { sourceId: 'zigbee', deviceId: SOCKET.id, propertyKey: 'state', valueFrom: { kind: 'trigger' } },
      ],
    };
    const { mqtt } = await harness([rule]);

    mqtt.deliver(SWITCH.topic, { state_l2: 'ON' });
    expect(mqtt.published.at(-1)?.payload).toBe('{"state":"ON"}');
  });
});

describe('repeats versus changes', () => {
  it('fires again when a button is pressed twice', async () => {
    const { mqtt } = await harness([buttonRule()]);
    mqtt.deliver(ROCKER.topic, { action: 'single_left' });
    mqtt.deliver(ROCKER.topic, { action: 'single_left' });
    // Two presses are two events, even though the value did not change.
    expect(mqtt.published).toHaveLength(2);
  });

  it('changedTo ignores a device repeating a state it already had', async () => {
    const rule = buttonRule({
      trigger: {
        sourceId: 'zigbee',
        deviceId: SWITCH.id,
        propertyKey: 'state_l1',
        match: { kind: 'changedTo', value: 'ON' },
      },
    });
    const { mqtt } = await harness([rule]);

    mqtt.deliver(SWITCH.topic, { state_l1: 'ON' });
    expect(mqtt.published).toHaveLength(1);

    // Zigbee2MQTT republishes full state constantly. Firing on each would be
    // unusable.
    mqtt.deliver(SWITCH.topic, { state_l1: 'ON' });
    mqtt.deliver(SWITCH.topic, { state_l1: 'ON' });
    expect(mqtt.published).toHaveLength(1);

    mqtt.deliver(SWITCH.topic, { state_l1: 'OFF' });
    mqtt.deliver(SWITCH.topic, { state_l1: 'ON' });
    expect(mqtt.published).toHaveLength(2);
  });
});

describe('retained messages', () => {
  it('never fires on a replay after a reconnect', async () => {
    const { mqtt } = await harness([buttonRule()]);
    mqtt.deliver(ROCKER.topic, { action: 'single_left' }, { retained: true });
    expect(mqtt.published).toEqual([]);
  });

  it('still learns the value, so the next change is judged against it', async () => {
    const rule = buttonRule({
      trigger: {
        sourceId: 'zigbee',
        deviceId: SWITCH.id,
        propertyKey: 'state_l1',
        match: { kind: 'changedTo', value: 'ON' },
      },
    });
    const { mqtt } = await harness([rule]);

    mqtt.deliver(SWITCH.topic, { state_l1: 'ON' }, { retained: true });
    // It was already on when we connected, so this is not a change to on.
    mqtt.deliver(SWITCH.topic, { state_l1: 'ON' });
    expect(mqtt.published).toEqual([]);
  });
});

describe('branches', () => {
  /** When the button is pressed: if l2 is on do A, else if it is off do B. */
  const branching = (): Rule => ({
    ...buttonRule(),
    conditions: undefined,
    actions: undefined as never,
    branches: [
      {
        label: 'while on',
        when: {
          kind: 'test',
          sourceId: 'zigbee',
          deviceId: SWITCH.id,
          propertyKey: 'state_l2',
          match: { kind: 'equals', value: 'ON' },
        },
        actions: [{ sourceId: 'zigbee', deviceId: SOCKET.id, propertyKey: 'state', value: 'ON' }],
      },
      {
        label: 'otherwise',
        actions: [{ sourceId: 'zigbee', deviceId: SOCKET.id, propertyKey: 'state', value: 'OFF' }],
      },
    ],
  });

  it('runs the first branch that holds', async () => {
    const { mqtt } = await harness([branching()]);
    mqtt.deliver(SWITCH.topic, { state_l2: 'ON' });
    mqtt.deliver(ROCKER.topic, { action: 'single_left' });

    expect(mqtt.published.at(-1)?.payload).toBe('{"state":"ON"}');
  });

  it('falls through to the otherwise', async () => {
    const { mqtt } = await harness([branching()]);
    mqtt.deliver(SWITCH.topic, { state_l2: 'OFF' });
    mqtt.deliver(ROCKER.topic, { action: 'single_left' });

    expect(mqtt.published.at(-1)?.payload).toBe('{"state":"OFF"}');
  });

  it('runs one branch and no more', async () => {
    const { mqtt } = await harness([branching()]);
    mqtt.deliver(SWITCH.topic, { state_l2: 'ON' });
    mqtt.deliver(ROCKER.topic, { action: 'single_left' });

    // Exclusivity is structural, not something the conditions have to arrange.
    expect(mqtt.published).toHaveLength(1);
  });

  it('says which branch ran', async () => {
    const { engine, mqtt } = await harness([branching()]);
    mqtt.deliver(SWITCH.topic, { state_l2: 'ON' });
    mqtt.deliver(ROCKER.topic, { action: 'single_left' });

    expect(engine.getLog()[0]?.detail).toContain('while on');
  });

  it('does nothing, and says why, when no branch holds', async () => {
    const rule = branching();
    rule.branches = [rule.branches![0]!];
    const { engine, mqtt } = await harness([rule]);

    mqtt.deliver(SWITCH.topic, { state_l2: 'OFF' });
    mqtt.deliver(ROCKER.topic, { action: 'single_left' });

    expect(mqtt.published).toEqual([]);
    expect(engine.getLog()[0]).toMatchObject({ outcome: 'conditionsFailed' });
    expect(engine.getLog()[0]?.detail).toContain('while on');
  });

  it('still runs a rule stored with a single outcome', async () => {
    const { mqtt } = await harness([buttonRule()]);
    mqtt.deliver(ROCKER.topic, { action: 'single_left' });
    expect(mqtt.published).toHaveLength(1);
  });
});

describe('conditions', () => {
  it('holds the action back when a condition fails', async () => {
    const rule = buttonRule({
      conditions: [
        {
          sourceId: 'zigbee',
          deviceId: SWITCH.id,
          propertyKey: 'state_l2',
          match: { kind: 'equals', value: 'ON' },
        },
      ],
    });
    const { mqtt } = await harness([rule]);

    mqtt.deliver(SWITCH.topic, { state_l2: 'OFF' });
    mqtt.deliver(ROCKER.topic, { action: 'single_left' });
    expect(mqtt.published).toEqual([]);

    mqtt.deliver(SWITCH.topic, { state_l2: 'ON' });
    mqtt.deliver(ROCKER.topic, { action: 'single_left' });
    expect(mqtt.published).toHaveLength(1);
  });

  it('says why it did not run', async () => {
    const rule = buttonRule({
      conditions: [
        {
          sourceId: 'zigbee',
          deviceId: SWITCH.id,
          propertyKey: 'state_l2',
          match: { kind: 'equals', value: 'ON' },
        },
      ],
    });
    const { engine, mqtt } = await harness([rule]);
    mqtt.deliver(ROCKER.topic, { action: 'single_left' });

    expect(engine.getLog()[0]).toMatchObject({ outcome: 'conditionsFailed' });
    expect(engine.getLog()[0]?.detail).toContain('no value known yet');
  });
});

describe('loop protection', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('will not fire faster than its rate limit', async () => {
    const { mqtt } = await harness([buttonRule({ rateLimitMs: 5000 })]);

    mqtt.deliver(ROCKER.topic, { action: 'single_left' });
    mqtt.deliver(ROCKER.topic, { action: 'single_left' });
    expect(mqtt.published).toHaveLength(1);

    vi.advanceTimersByTime(5001);
    mqtt.deliver(ROCKER.topic, { action: 'single_left' });
    expect(mqtt.published).toHaveLength(2);
  });

  it('turns off a rule that is triggering itself', async () => {
    // Publishing to a device on the strength of that same device's state is
    // the shape a runaway takes.
    const rule = buttonRule({ rateLimitMs: 0 });
    const { engine, store, mqtt } = await harness([rule]);

    for (let press = 0; press <= RUNAWAY_FIRINGS; press++) {
      mqtt.deliver(ROCKER.topic, { action: 'single_left' });
    }

    expect(store.data.rules[0]?.enabled).toBe(false);
    expect(engine.getLog()[0]).toMatchObject({ outcome: 'disabled' });
    expect(mqtt.published).toHaveLength(RUNAWAY_FIRINGS);
  });
});

describe('delayed actions', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits before sending', async () => {
    const rule = buttonRule({
      actions: [
        { sourceId: 'zigbee', deviceId: SWITCH.id, propertyKey: 'state_l1', value: 'OFF', delayMs: 60000 },
      ],
    });
    const { mqtt } = await harness([rule]);

    mqtt.deliver(ROCKER.topic, { action: 'single_left' });
    expect(mqtt.published).toEqual([]);

    vi.advanceTimersByTime(60000);
    expect(mqtt.published).toHaveLength(1);
  });

  it('drops pending actions when stopped', async () => {
    const rule = buttonRule({
      actions: [
        { sourceId: 'zigbee', deviceId: SWITCH.id, propertyKey: 'state_l1', value: 'OFF', delayMs: 60000 },
      ],
    });
    const { engine, mqtt } = await harness([rule]);

    mqtt.deliver(ROCKER.topic, { action: 'single_left' });
    engine.stop();
    vi.advanceTimersByTime(60000);

    // Firing after Homebridge has begun shutting down would be a surprise.
    expect(mqtt.published).toEqual([]);
  });
});

describe('the run log', () => {
  it('records what happened, newest first', async () => {
    const { engine, mqtt } = await harness([buttonRule()]);
    mqtt.deliver(ROCKER.topic, { action: 'single_left' });

    expect(engine.getLog()[0]).toMatchObject({
      ruleName: 'Left button turns the lamp on',
      outcome: 'fired',
    });
  });

  it('explains an action it cannot carry out', async () => {
    const rule = buttonRule({
      actions: [
        { sourceId: 'zigbee', deviceId: SWITCH.id, propertyKey: 'linkquality', value: 1 },
      ],
    });
    const { engine, mqtt } = await harness([rule]);
    mqtt.deliver(ROCKER.topic, { action: 'single_left' });

    expect(engine.getLog()[0]).toMatchObject({ outcome: 'failed' });
    expect(engine.getLog()[0]?.detail).toContain('cannot be written to');
    expect(mqtt.published).toEqual([]);
  });
});
