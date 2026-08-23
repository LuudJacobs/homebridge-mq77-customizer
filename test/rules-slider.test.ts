import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Catalog } from '../src/catalog.js';
import { silentLogger } from '../src/logger.js';
import { RulesEngine } from '../src/rules/engine.js';
import type { SliderRule } from '../src/rules/types.js';
import { Store } from '../src/store.js';
import fixture from './fixtures/bridge-devices.json' with { type: 'json' };
import { FakeMqtt } from './helpers/fake-mqtt.js';

/** The Candeo dimmer: brightness 0 to 254, with its own on and off. */
const DIMMER = { id: '0x1cc089fffe39c60e', topic: 'zigbee2mqtt/keuken_dimmer-candeo' };
/** An Aqara rocker, whose presses drive the dimmer. */
const ROCKER = { id: '0x54ef44100169b28a', topic: 'zigbee2mqtt/slaapkamer_schakelaar-wrs02' };

const press = (value: string) => ({
  sourceId: 'zigbee',
  deviceId: ROCKER.id,
  propertyKey: 'action',
  match: { kind: 'changedTo' as const, value },
});

function sliderRule(overrides: Partial<SliderRule> = {}): SliderRule {
  return {
    id: 's1',
    kind: 'slider',
    name: 'Dining dimmer',
    enabled: true,
    target: { sourceId: 'zigbee', deviceId: DIMMER.id, propertyKey: 'brightness' },
    power: { sourceId: 'zigbee', deviceId: DIMMER.id, propertyKey: 'state' },
    steps: 4,
    up: [press('single_left')],
    down: [press('single_right')],
    on: [press('double_left')],
    off: [press('double_right')],
    ...overrides,
  };
}

async function harness(rules: SliderRule[]) {
  const directory = await mkdtemp(join(tmpdir(), 'mq77-slider-'));
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

const sent = (mqtt: FakeMqtt) => mqtt.published.map((message) => message.payload);

/**
 * A press, the way Zigbee2MQTT reports one.
 *
 * The action is published and then cleared, which is what lets the same
 * button register twice in a row: without the clear the second press is not
 * a change to anything.
 */
function pressed(mqtt: FakeMqtt, action: string): void {
  mqtt.deliver(ROCKER.topic, { action });
  mqtt.deliver(ROCKER.topic, { action: '' });
}

describe('stepping a dimmer', () => {
  it('comes on at the first step when nothing is known about it', async () => {
    const { mqtt } = await harness([sliderRule()]);
    mqtt.deliver(ROCKER.topic, { action: 'single_left' });

    // Never reported, so it counts as off and the first press is step one.
    expect(sent(mqtt)).toEqual(['{"state":"ON"}', '{"brightness":64}']);
  });

  it('climbs a step at a time', async () => {
    const { mqtt } = await harness([sliderRule()]);
    mqtt.deliver(DIMMER.topic, { state: 'ON', brightness: 127 });

    mqtt.deliver(ROCKER.topic, { action: 'single_left' });
    // Halfway on a ladder of four is step two, so up is step three.
    expect(sent(mqtt)).toEqual(['{"brightness":191}']);
  });

  it('carries on from the last press rather than the last report', async () => {
    const { mqtt } = await harness([sliderRule()]);
    mqtt.deliver(DIMMER.topic, { state: 'ON', brightness: 0 });

    // A held button sends faster than a light reports back.
    pressed(mqtt, 'single_left');
    pressed(mqtt, 'single_left');
    pressed(mqtt, 'single_left');

    expect(sent(mqtt).filter((payload) => payload.includes('brightness'))).toEqual([
      '{"brightness":64}',
      '{"brightness":127}',
      '{"brightness":191}',
    ]);
  });

  it('stops at the top rather than sending the same thing again', async () => {
    const { engine, mqtt } = await harness([sliderRule()]);
    mqtt.deliver(DIMMER.topic, { state: 'ON', brightness: 254 });

    mqtt.deliver(ROCKER.topic, { action: 'single_left' });
    expect(mqtt.published).toEqual([]);
    expect(engine.getLog()[0]).toMatchObject({ outcome: 'skipped' });
  });

  it('turns the light off at the bottom instead of leaving it dark and on', async () => {
    const { mqtt } = await harness([sliderRule()]);
    mqtt.deliver(DIMMER.topic, { state: 'ON', brightness: 64 });

    mqtt.deliver(ROCKER.topic, { action: 'single_right' });
    expect(sent(mqtt)).toEqual(['{"state":"OFF"}']);
  });

  it('steps down without switching off when there is room', async () => {
    const { mqtt } = await harness([sliderRule()]);
    mqtt.deliver(DIMMER.topic, { state: 'ON', brightness: 254 });

    mqtt.deliver(ROCKER.topic, { action: 'single_right' });
    expect(sent(mqtt)).toEqual(['{"brightness":191}']);
  });

  it('counts a light that is off as being at zero, whatever its brightness says', async () => {
    const { mqtt } = await harness([sliderRule()]);
    // Many lights keep their last brightness while switched off.
    mqtt.deliver(DIMMER.topic, { state: 'OFF', brightness: 254 });

    mqtt.deliver(ROCKER.topic, { action: 'single_left' });
    expect(sent(mqtt)).toEqual(['{"state":"ON"}', '{"brightness":64}']);
  });

  it('respects a ceiling set below what the device allows', async () => {
    const { mqtt } = await harness([sliderRule({ max: 127, steps: 2 })]);
    mqtt.deliver(DIMMER.topic, { state: 'OFF' });

    pressed(mqtt, 'single_left');
    pressed(mqtt, 'single_left');
    expect(sent(mqtt).at(-1)).toBe('{"brightness":127}');
  });
});

describe('coming on from off', () => {
  it('lands where it was told to, not at the first step', async () => {
    const { mqtt } = await harness([sliderRule({ onLevel: 200 })]);
    mqtt.deliver(DIMMER.topic, { state: 'OFF' });

    pressed(mqtt, 'single_left');
    // The first step is dim for a light somebody has just asked for.
    expect(sent(mqtt)).toEqual(['{"state":"ON"}', '{"brightness":200}']);
  });

  it('carries on from there rather than from the step it skipped', async () => {
    const { mqtt } = await harness([sliderRule({ onLevel: 200 })]);
    mqtt.deliver(DIMMER.topic, { state: 'OFF' });

    pressed(mqtt, 'single_left');
    pressed(mqtt, 'single_left');
    // 200 is nearest step three of four, so the next press is step four.
    expect(sent(mqtt).at(-1)).toBe('{"brightness":254}');
  });

  it('keeps the level inside what the device takes', async () => {
    const { mqtt } = await harness([sliderRule({ onLevel: 9999 })]);
    mqtt.deliver(DIMMER.topic, { state: 'OFF' });

    pressed(mqtt, 'single_left');
    expect(sent(mqtt).at(-1)).toBe('{"brightness":254}');
  });

  it('still steps normally once it is on', async () => {
    const { mqtt } = await harness([sliderRule({ onLevel: 200 })]);
    mqtt.deliver(DIMMER.topic, { state: 'ON', brightness: 64 });

    pressed(mqtt, 'single_left');
    // On already, so the on level has nothing to do with it.
    expect(sent(mqtt)).toEqual(['{"brightness":127}']);
  });
});

describe('several buttons doing the same thing', () => {
  it('takes a press from any of them', async () => {
    const { mqtt } = await harness([
      sliderRule({ up: [press('single_left'), press('single_both')] }),
    ]);
    mqtt.deliver(DIMMER.topic, { state: 'ON', brightness: 127 });

    pressed(mqtt, 'single_both');
    expect(sent(mqtt)).toEqual(['{"brightness":191}']);
  });

  it('counts a message satisfying two of them as one press', async () => {
    const { mqtt } = await harness([
      sliderRule({ up: [press('single_left'), press('single_left')] }),
    ]);
    mqtt.deliver(DIMMER.topic, { state: 'ON', brightness: 127 });

    pressed(mqtt, 'single_left');
    expect(sent(mqtt)).toEqual(['{"brightness":191}']);
  });

  it('still reads a slider stored with one trigger per button', async () => {
    // Written by the version before buttons took lists.
    const { mqtt } = await harness([sliderRule({ up: press('single_left') as never })]);
    mqtt.deliver(DIMMER.topic, { state: 'ON', brightness: 127 });

    pressed(mqtt, 'single_left');
    expect(sent(mqtt)).toEqual(['{"brightness":191}']);
  });
});

describe('the power buttons', () => {
  it('switches on and off', async () => {
    const { mqtt } = await harness([sliderRule()]);

    mqtt.deliver(ROCKER.topic, { action: 'double_left' });
    expect(sent(mqtt)).toEqual(['{"state":"ON"}']);

    mqtt.deliver(ROCKER.topic, { action: 'double_right' });
    expect(sent(mqtt)).toEqual(['{"state":"ON"}', '{"state":"OFF"}']);
  });

  it('ignores a press that belongs to no button', async () => {
    const { mqtt } = await harness([sliderRule()]);
    mqtt.deliver(ROCKER.topic, { action: 'hold_left' });
    expect(mqtt.published).toEqual([]);
  });

  it('does nothing while disabled', async () => {
    const { mqtt } = await harness([sliderRule({ enabled: false })]);
    mqtt.deliver(ROCKER.topic, { action: 'single_left' });
    expect(mqtt.published).toEqual([]);
  });
});

describe('what the log says', () => {
  it('marks the entry as a slider, so the activity list can split it out', async () => {
    const { engine, mqtt } = await harness([sliderRule()]);
    mqtt.deliver(ROCKER.topic, { action: 'single_left' });

    expect(engine.getLog()[0]).toMatchObject({ ruleKind: 'slider', outcome: 'fired' });
    expect(engine.getLog()[0]?.detail).toContain('step 1 of 4');
  });

  it('says so when the light cannot be switched', async () => {
    const { engine, mqtt } = await harness([sliderRule({ power: undefined })]);
    mqtt.deliver(ROCKER.topic, { action: 'double_left' });

    expect(engine.getLog()[0]).toMatchObject({ outcome: 'failed' });
    expect(mqtt.published).toEqual([]);
  });
});
