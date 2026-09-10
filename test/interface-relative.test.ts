import { describe, expect, it } from 'vitest';

import { openInterface } from './helpers/interface.js';

const property = (over: Record<string, unknown>) => ({
  key: 'state',
  label: 'State',
  semantic: 'state',
  type: 'binary',
  category: 'primary',
  endpoint: '',
  readable: true,
  writable: true,
  publishable: true,
  role: 'power',
  onValue: 'ON',
  offValue: 'OFF',
  ...over,
});

const device = (deviceId: string, name: string, properties: Record<string, unknown>[]) => ({
  sourceId: 'zigbee',
  deviceId,
  name,
  topic: `zigbee2mqtt/${name}`,
  manufacturer: 'SONOFF',
  model: 'ZBMINIL2',
  rulesOnly: false,
  renameable: false,
  endpoints: [''],
  properties,
  exposure: { properties: [] },
  state: {},
  lastSeen: {},
});

/** A thermostat and a lamp: one value that can be moved, one that cannot. */
const devices = [
  device('0xa', 'lamp', [property({})]),
  device('0xt', 'thermostat', [
    property({
      key: 'occupied_heating_setpoint',
      label: 'Setpoint',
      semantic: 'occupied_heating_setpoint',
      type: 'numeric',
      role: undefined,
      unit: '°C',
      min: 5,
      max: 30,
      step: 0.5,
      onValue: undefined,
      offValue: undefined,
    }),
  ]),
];

const ref = (deviceId: string, propertyKey: string) => ({
  sourceId: 'zigbee',
  deviceId,
  propertyKey,
});

const rule = (action: Record<string, unknown>) => ({
  id: 'r1',
  name: 'Warmer',
  enabled: true,
  triggers: [{ ...ref('0xa', 'state'), match: { kind: 'changedTo', value: 'ON' } }],
  branches: [{ actions: [action] }],
});

async function openRule(action: Record<string, unknown>) {
  const ui = await openInterface({ state: { devices }, rules: [rule(action)] });
  await ui.click(ui.byText('button.tab', 'Automation'));
  await ui.openCard(ui.document.querySelector('.rule') as HTMLDetailsElement);
  return ui;
}

/** The select that says how the value is arrived at, whichever place it sits. */
const mode = (ui: { document: Document }) =>
  [...ui.document.querySelectorAll('.actions select')].find((select) =>
    [...(select as HTMLSelectElement).options].some((option) => option.textContent === 'set to'),
  ) as HTMLSelectElement;

const modes = (ui: { document: Document }) =>
  [...mode(ui).options].map((option) => option.textContent);

const amount = (ui: { document: Document }) =>
  ui.document.querySelector('.actions input.amount') as HTMLInputElement | null;

describe('moving a value from the action row', () => {
  it('offers it on a number, and not on a switch', async () => {
    const warm = await openRule({ ...ref('0xt', 'occupied_heating_setpoint'), value: 20 });
    expect(modes(warm)).toEqual(['set to', 'match the trigger', 'increase by', 'decrease by']);

    const lamp = await openRule({ ...ref('0xa', 'state'), value: 'ON' });
    expect(modes(lamp)).toEqual(['set to', 'match the trigger']);
  });

  it('keeps one already set, whatever the device says now', async () => {
    // The rule outlives the device that could take it: it is still what the
    // rule says, and opening it must not quietly rewrite it.
    const ui = await openRule({
      ...ref('0xa', 'state'),
      valueFrom: { kind: 'add' },
      value: 1,
    });
    expect(modes(ui)).toContain('increase by');
    expect(mode(ui).value).toBe('add');
  });

  it('swaps the value box for an amount, seeded with the step', async () => {
    const ui = await openRule({ ...ref('0xt', 'occupied_heating_setpoint'), value: 20 });
    expect(amount(ui)).toBeNull();

    mode(ui).value = 'add';
    mode(ui).dispatchEvent(new ui.window.Event('change'));
    await ui.settle();

    const box = amount(ui);
    expect(box).not.toBeNull();
    // Half a degree, which is what this thermostat moves in.
    expect(box!.value).toBe('0.5');
    // An amount is not a temperature, so the device's own range says nothing
    // about it: a setpoint that stops at five still moves by half a degree.
    expect(box!.getAttribute('min')).toBeNull();
    expect(box!.getAttribute('max')).toBeNull();
  });

  it('sends the way and the amount when saved, and reads them back', async () => {
    const ui = await openRule({ ...ref('0xt', 'occupied_heating_setpoint'), value: 20 });

    mode(ui).value = 'subtract';
    mode(ui).dispatchEvent(new ui.window.Event('change'));
    await ui.settle();

    const box = amount(ui)!;
    box.value = '2';
    box.dispatchEvent(new ui.window.Event('input'));
    await ui.settle();

    await ui.click(ui.byText('button.primary', 'Save'));
    const saved = ui.requests.findLast((request) => request.body !== undefined)?.body as {
      branches: { actions: { valueFrom?: { kind: string }; value?: unknown }[] }[];
    };
    expect(saved.branches[0]?.actions[0]).toMatchObject({
      valueFrom: { kind: 'subtract' },
      value: 2,
    });

    // And a rule stored that way opens as what it is.
    const again = await openRule({
      ...ref('0xt', 'occupied_heating_setpoint'),
      valueFrom: { kind: 'subtract' },
      value: 2,
    });
    expect(mode(again).value).toBe('subtract');
    expect(amount(again)!.value).toBe('2');
  });

  it('drops the amount when it goes back to setting a value', async () => {
    const ui = await openRule({
      ...ref('0xt', 'occupied_heating_setpoint'),
      valueFrom: { kind: 'add' },
      value: 0.5,
    });

    mode(ui).value = 'literal';
    mode(ui).dispatchEvent(new ui.window.Event('change'));
    await ui.settle();

    // Half a degree is an amount, and would be five degrees short of a
    // setpoint this thermostat would take.
    expect(amount(ui)).toBeNull();
    const box = ui.document.querySelector('.actions input[type="number"]') as HTMLInputElement;
    expect(box.value).toBe('');
    expect(box.getAttribute('min')).toBe('5');
  });
});
