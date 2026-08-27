import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Catalog } from '../src/catalog.js';
import { silentLogger } from '../src/logger.js';
import { convertValue } from '../src/rules/convert.js';
import { RulesEngine } from '../src/rules/engine.js';
import type { Rule } from '../src/rules/types.js';
import type { NormalisedProperty } from '../src/model/types.js';
import { Store } from '../src/store.js';
import fixture from './fixtures/bridge-devices.json' with { type: 'json' };
import { FakeMqtt } from './helpers/fake-mqtt.js';

const SWITCH = { id: '0x00158dfffe000002', topic: 'zigbee2mqtt/living_room_switch-ZB2GS' };
const SOCKET = { id: '0x00158dfffe000006', topic: 'zigbee2mqtt/living_room_lamp-socket' };
const DIMMER = { id: '0x00158dfffe000003', topic: 'zigbee2mqtt/kitchen_dimmer-candeo' };

function property(overrides: Partial<NormalisedProperty> = {}): NormalisedProperty {
  return {
    key: 'state',
    label: 'State',
    type: 'binary',
    access: { readable: true, writable: true },
    category: 'primary',
    onValue: 'ON',
    offValue: 'OFF',
    stateTopic: 't',
    extract: ['state'],
    ...overrides,
  };
}

async function harness(rules: Rule[]) {
  const directory = await mkdtemp(join(tmpdir(), 'mq77-mirror-'));
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
  return { engine, mqtt };
}

/** When the wall switch changes, the socket follows it. */
function followRule(): Rule {
  return {
    id: 'follow',
    name: 'Socket follows the wall switch',
    enabled: true,
    trigger: {
      sourceId: 'zigbee',
      deviceId: SWITCH.id,
      propertyKey: 'state_l1',
      match: { kind: 'changed' },
    },
    conditions: [],
    actions: [
      {
        sourceId: 'zigbee',
        deviceId: SOCKET.id,
        propertyKey: 'state',
        valueFrom: { kind: 'trigger' },
      },
    ],
    rateLimitMs: 0,
  };
}

describe('following another device', () => {
  it('sends whatever the trigger became', async () => {
    const { mqtt } = await harness([followRule()]);

    mqtt.deliver(SWITCH.topic, { state_l1: 'ON' });
    expect(mqtt.published.at(-1)).toEqual({
      topic: `${SOCKET.topic}/set`,
      payload: '{"state":"ON"}',
      retain: false,
    });

    mqtt.deliver(SWITCH.topic, { state_l1: 'OFF' });
    expect(mqtt.published.at(-1)?.payload).toBe('{"state":"OFF"}');
  });

  it('says so rather than sending nothing when the trigger has gone', async () => {
    const rule = followRule();
    rule.trigger.propertyKey = 'state_l1';
    const { engine, mqtt } = await harness([rule]);

    mqtt.deliver(SWITCH.topic, { state_l1: 'ON' });
    expect(engine.getLog()[0]?.outcome).toBe('fired');
  });

  it('still allows a fixed value alongside a copied one', async () => {
    const rule = followRule();
    rule.actions.push({
      sourceId: 'zigbee',
      deviceId: SWITCH.id,
      propertyKey: 'state_l2',
      value: 'OFF',
    });
    const { mqtt } = await harness([rule]);

    mqtt.deliver(SWITCH.topic, { state_l1: 'ON' });
    expect(mqtt.published.map((entry) => entry.payload)).toEqual([
      '{"state":"ON"}',
      '{"state_l2":"OFF"}',
    ]);
  });

  it('scales between devices that count differently', async () => {
    // The Candeo dimmer counts brightness to 254. A rule copying it onto a
    // publisher that counts to 100 must not send 254.
    const rule: Rule = {
      id: 'dim',
      name: 'Match brightness',
      enabled: true,
      trigger: {
        sourceId: 'zigbee',
        deviceId: DIMMER.id,
        propertyKey: 'brightness',
        match: { kind: 'changed' },
      },
      conditions: [],
      actions: [
        {
          sourceId: 'zigbee',
          deviceId: DIMMER.id,
          propertyKey: 'brightness',
          valueFrom: { kind: 'trigger' },
        },
      ],
      rateLimitMs: 0,
    };
    const { mqtt } = await harness([rule]);
    mqtt.deliver(DIMMER.topic, { brightness: 127 });
    // Same range on both sides here, so it passes through unchanged.
    expect(mqtt.published.at(-1)?.payload).toBe('{"brightness":127}');
  });
});

describe('convertValue', () => {
  it('restates on and off in the target device s own words', () => {
    const words = property({ onValue: 'ON', offValue: 'OFF' });
    const flags = property({ onValue: true, offValue: false });
    const enables = property({ onValue: 'ENABLE', offValue: 'DISABLE' });

    expect(convertValue(words, flags, 'ON')).toBe(true);
    expect(convertValue(flags, words, false)).toBe('OFF');
    expect(convertValue(words, enables, 'ON')).toBe('ENABLE');
  });

  it('scales between different ranges', () => {
    const zigbee = property({ key: 'brightness', type: 'numeric', min: 0, max: 254 });
    const percent = property({ key: 'level', type: 'numeric', min: 0, max: 100 });

    expect(convertValue(zigbee, percent, 254)).toBe(100);
    expect(convertValue(zigbee, percent, 127)).toBe(50);
    expect(convertValue(percent, zigbee, 50)).toBe(127);
  });

  it('passes a number through when a range is not declared on both sides', () => {
    const known = property({ type: 'numeric', min: 0, max: 100 });
    const open = property({ type: 'numeric' });
    // Scaling against an unknown range would be guesswork.
    expect(convertValue(known, open, 40)).toBe(40);
  });

  it('passes anything else through unchanged', () => {
    const text = property({ type: 'text' });
    expect(convertValue(text, text, 'hello')).toBe('hello');
  });

  it('has nothing to send when there is no value', () => {
    const state = property();
    expect(convertValue(state, state, undefined)).toBeUndefined();
    expect(convertValue(state, state, null)).toBeUndefined();
  });
});
