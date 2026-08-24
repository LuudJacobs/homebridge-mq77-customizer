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

describe('saying an action properly', () => {
  const remote = (values: string[]) => [
    { ...devices[0]!, properties: [{ ...action, values }] },
    devices[1]!,
  ];

  async function optionsFor(values: string[]) {
    const ui = await openInterface({
      state: { devices: remote(values) },
      rules: [automation('r1', 'First', values[0]!)],
    });
    await ui.click(ui.byText('button.tab', 'Automation'));
    await ui.openCard(ui.document.querySelector('#automation .rule'));
    return onTrigger(ui);
  }

  it('says a button and what was done to it', async () => {
    expect(await optionsFor(['1_single', '1_double', '1_hold'])).toEqual([
      '1 Single',
      '1 Double',
      '1 Hold',
    ]);
  });

  it('reads a long press as one gesture rather than two', async () => {
    // `single_long` must not be taken apart as `long` with a button of
    // `1_single`, which is what a shorter list of gestures would do.
    expect(await optionsFor(['1_single_long', '1_single'])).toEqual(['1 Single', '1 Single Long']);
  });

  it('copes with the gesture coming first', async () => {
    expect(await optionsFor(['single_left', 'double_both', 'hold_right'])).toEqual([
      'Left Single',
      'Right Hold',
      'Both Double',
    ]);
  });

  it('puts the buttons in the order somebody would read them', async () => {
    const jumbled = ['3_single', '1_double', 'both_single', '1_single', '2_single', 'left_single'];
    expect(await optionsFor(jumbled)).toEqual([
      '1 Single',
      '1 Double',
      '2 Single',
      '3 Single',
      'Left Single',
      'Both Single',
    ]);
  });

  it('leaves something it cannot read alone', async () => {
    expect(await optionsFor(['W100_PMTSD_request', '1_single'])).toContain('W100 PMTSD Request');
  });

  it('sends the value the device uses, not the words on screen', async () => {
    const ui = await openInterface({
      state: { devices },
      rules: [automation('r1', 'First', '1_single')],
    });
    await ui.click(ui.byText('button.tab', 'Automation'));
    await ui.openCard(ui.document.querySelector('#automation .rule'));

    const selects = ui.document.querySelectorAll('#automation .triggers .rule-row select');
    const value = selects[selects.length - 1] as HTMLSelectElement;
    expect(value.value).toBe('1_single');

    value.value = '3_double';
    value.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();
    await ui.click(ui.byText('button.primary', 'Save', '#automation'));

    const saved = ui.requests.findLast((request) => request.body !== undefined)?.body as {
      triggers: { match: { value: string } }[];
    };
    expect(saved.triggers[0]?.match.value).toBe('3_double');
  });
});

describe('a button already spoken for', () => {
  it('marks a value another rule is using', async () => {
    const ui = await openAutomation([automation('r1', 'First', '1_single'), automation('r2', 'Second', '2_single')]);

    // Editing the first: the second rule holds 2_single.
    expect(onTrigger(ui)).toEqual(['1 Single', '2 Single *', '3 Double']);
  });

  it('says nothing about the value this rule is using itself', async () => {
    const ui = await openAutomation([automation('r1', 'Only one', '1_single')]);

    // Its own choice is not a warning.
    expect(onTrigger(ui)).toEqual(['1 Single', '2 Single', '3 Double']);
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

    expect(onTrigger(ui)).toEqual(['1 Single', '2 Single', '3 Double *']);
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

    expect(onTrigger(ui)).toEqual(['1 Single', '2 Single *', '3 Double']);
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
      '1 Single',
      '2 Single',
      '3 Double',
    ]);
  });
});
