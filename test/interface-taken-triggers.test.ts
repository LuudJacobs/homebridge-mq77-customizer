import { describe, expect, it } from 'vitest';

import { openInterface } from './helpers/interface.js';

const action = {
  key: 'action',
  label: 'Action',
  semantic: 'action',
  type: 'enum',
  category: 'primary',
  endpoint: '',
  readable: true,
  writable: false,
  publishable: true,
  role: 'action',
  values: ['1_single', '2_single', '3_double'],
};

const power = {
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
};

const device = (deviceId: string, name: string, properties: unknown[]) => ({
  sourceId: 'zigbee',
  deviceId,
  name,
  topic: `zigbee2mqtt/${name}`,
  manufacturer: 'Shelly',
  model: 'remote',
  rulesOnly: false,
  renameable: false,
  endpoints: [''],
  properties,
  exposure: { properties: [] },
  state: {},
  lastSeen: {},
});

const devices = [
  device('0xr', 'remote', [action]),
  device('0xl', 'lamp', [power]),
];

const press = (value: string) => ({
  sourceId: 'zigbee',
  deviceId: '0xr',
  propertyKey: 'action',
  match: { kind: 'changedTo', value },
});

const automation = (id: string, name: string, value: string) => ({
  id,
  name,
  enabled: true,
  triggers: [press(value)],
  branches: [
    { actions: [{ sourceId: 'zigbee', deviceId: '0xl', propertyKey: 'state', value: 'ON' }] },
  ],
});

async function openAutomation(rules: unknown[], which = 0) {
  const ui = await openInterface({ state: { devices }, rules });
  await ui.click(ui.byText('button.tab', 'Automation'));
  await ui.openCard(ui.document.querySelectorAll('#automation .rule')[which]!);
  return ui;
}

/**
 * What a value dropdown offers, as it is written on screen.
 *
 * The last select on the row: device, then function, then how to match, then
 * what to match against.
 */
function offered(ui: { document: Document }, within: string): (string | null)[] {
  const selects = ui.document.querySelectorAll(`${within} .rule-row select`);
  const value = selects[selects.length - 1] as HTMLSelectElement;
  return [...value.options].map((option) => option.textContent);
}

const onTrigger = (ui: { document: Document }) => offered(ui, '#automation .triggers');

describe('a button already spoken for', () => {
  it('marks a value another rule is using', async () => {
    const ui = await openAutomation([automation('r1', 'First', '1_single'), automation('r2', 'Second', '2_single')]);

    // Editing the first: the second rule holds 2_single.
    expect(onTrigger(ui)).toEqual(['1_single', '2_single *', '3_double']);
  });

  it('says nothing about the value this rule is using itself', async () => {
    const ui = await openAutomation([automation('r1', 'Only one', '1_single')]);

    // Its own choice is not a warning.
    expect(onTrigger(ui)).toEqual(['1_single', '2_single', '3_double']);
  });

  it('counts a slider button as spoken for', async () => {
    const slider = {
      id: 's1',
      kind: 'slider',
      name: 'Dimmer',
      enabled: true,
      target: { sourceId: 'zigbee', deviceId: '0xl', propertyKey: 'state' },
      steps: 4,
      up: [press('3_double')],
    };
    const ui = await openAutomation([automation('r1', 'First', '1_single'), slider]);

    expect(onTrigger(ui)).toEqual(['1_single', '2_single', '3_double *']);
  });

  it('counts a timer as spoken for', async () => {
    const timer = {
      id: 't1',
      kind: 'timer',
      name: 'Light out',
      enabled: true,
      triggers: [press('2_single')],
      waitMs: 30_000,
      actions: [{ sourceId: 'zigbee', deviceId: '0xl', propertyKey: 'state', value: 'OFF' }],
    };
    const ui = await openAutomation([automation('r1', 'First', '1_single'), timer]);

    expect(onTrigger(ui)).toEqual(['1_single', '2_single *', '3_double']);
  });

  it('keeps the star out of what is saved', async () => {
    const ui = await openAutomation([automation('r1', 'First', '1_single'), automation('r2', 'Second', '2_single')]);

    const selects = ui.document.querySelectorAll('#automation .triggers .rule-row select');
    const value = selects[selects.length - 1] as HTMLSelectElement;
    value.value = '2_single';
    value.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();

    await ui.click(ui.byText('button.primary', 'Save', '#automation'));
    const saved = ui.requests.findLast((request) => request.body !== undefined)?.body as {
      triggers: { match: { value: string } }[];
    };
    expect(saved.triggers[0]?.match.value).toBe('2_single');
  });

  it('leaves conditions alone, since any number of rules may ask', async () => {
    const withCondition = {
      ...automation('r1', 'First', '1_single'),
      branches: [
        {
          when: {
            kind: 'test',
            sourceId: 'zigbee',
            deviceId: '0xr',
            propertyKey: 'action',
            match: { kind: 'equals', value: '1_single' },
          },
          actions: [
            { sourceId: 'zigbee', deviceId: '0xl', propertyKey: 'state', value: 'ON' },
          ],
        },
      ],
    };
    const ui = await openAutomation([withCondition, automation('r2', 'Second', '2_single')]);

    expect(offered(ui, '#automation .conditions')).toEqual([
      '1_single',
      '2_single',
      '3_double',
    ]);
  });
});
