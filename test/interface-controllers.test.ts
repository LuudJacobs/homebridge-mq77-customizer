import { describe, expect, it } from 'vitest';

import { openInterface } from './helpers/interface.js';

const action = (over: Record<string, unknown> = {}) => ({
  key: 'action',
  label: 'Action',
  semantic: 'action',
  type: 'enum',
  category: 'primary',
  endpoint: '',
  readable: true,
  writable: false,
  publishable: false,
  values: ['1_single', '1_double', '2_single'],
  ...over,
});

const state = () => ({
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
});

const device = (
  deviceId: string,
  name: string,
  exposure: Record<string, unknown>,
  properties: unknown[],
) => ({
  sourceId: 'zigbee',
  deviceId,
  name,
  topic: `zigbee2mqtt/${name}`,
  manufacturer: 'SONOFF',
  model: 'SNZB-01',
  rulesOnly: false,
  renameable: false,
  endpoints: [''],
  properties,
  exposure: { properties: [], ...exposure },
  state: {},
  lastSeen: {},
});

const devices = [
  device('0xr', 'remote_b', { label: 'Bank', room: 'Woonkamer', type: 'controller' }, [action()]),
  device('0xs', 'remote_a', { label: 'Deur', room: 'Gang', type: 'controller' }, [action()]),
  device('0xl', 'lamp', { label: 'Licht', room: 'Woonkamer', type: 'light' }, [state()]),
];

const starts = (deviceId: string, value: string) => ({
  sourceId: 'zigbee',
  deviceId,
  propertyKey: 'action',
  match: { kind: 'equals', value },
});

const rules = [
  {
    id: 'r1',
    kind: 'standard',
    name: 'Licht cycle',
    enabled: true,
    triggers: [starts('0xr', '1_single')],
    actions: [{ sourceId: 'zigbee', deviceId: '0xl', propertyKey: 'state', value: 'ON' }],
  },
  {
    id: 'r2',
    kind: 'standard',
    name: 'Alles uit',
    enabled: true,
    triggers: [starts('0xr', '1_single')],
    actions: [{ sourceId: 'zigbee', deviceId: '0xl', propertyKey: 'state', value: 'OFF' }],
  },
  {
    id: 's1',
    kind: 'slider',
    name: 'Dimmen',
    enabled: true,
    target: { sourceId: 'zigbee', deviceId: '0xl', propertyKey: 'state' },
    steps: 6,
    up: [starts('0xs', '1_single')],
    down: [starts('0xs', '1_double')],
  },
];

async function openControllers(over: { rules?: unknown[] } = {}) {
  const ui = await openInterface({ state: { devices }, rules: over.rules ?? rules });
  await ui.click(ui.byText('button.tab', 'Controllers'));
  return ui;
}

const table = (ui: { document: Document }) =>
  [...ui.document.querySelectorAll('#controllers .controller-card')].map((card) => ({
    name: card.querySelector('h2')?.textContent?.replace('Controller', '').trim(),
    rows: [...card.querySelectorAll('tr')]
      .slice(1)
      .map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent)),
  }));

describe('what every controller sets off', () => {
  it('lists controllers by name, buttons in the order they are read out', async () => {
    const ui = await openControllers();

    expect(table(ui).map((card) => card.name)).toEqual(['Gang Deur', 'Woonkamer Bank']);
    expect(table(ui)[0]?.rows.map((row) => row[0])).toEqual(['1 Single', '1 Double', '2 Single']);
  });

  it('says which part of a slider a button is', async () => {
    const ui = await openControllers();

    expect(table(ui)[0]?.rows).toEqual([
      ['1 Single', 'Woonkamer: Dimmen (up)'],
      ['1 Double', 'Woonkamer: Dimmen (down)'],
      ['2 Single', 'none'],
    ]);
  });

  it('gives a button two rules answer a row each', async () => {
    const ui = await openControllers();

    expect(table(ui)[1]?.rows).toEqual([
      ['1 Single', 'Woonkamer: Licht cycle'],
      ['1 Single', 'Woonkamer: Alles uit'],
      ['1 Double', 'none'],
      ['2 Single', 'none'],
    ]);
  });

  it('leaves the free buttons out when they are not wanted', async () => {
    const ui = await openControllers();
    const box = ui.document.getElementById('unused-buttons') as HTMLInputElement;
    box.checked = false;
    box.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();

    expect(table(ui)[1]?.rows).toEqual([
      ['1 Single', 'Woonkamer: Licht cycle'],
      ['1 Single', 'Woonkamer: Alles uit'],
    ]);
  });

  it('falls back to the buttons rules were built on when a device lists none', async () => {
    const bare = [
      device('0xr', 'remote_b', { label: 'Bank', room: 'Woonkamer', type: 'controller' }, [
        action({ values: undefined }),
      ]),
      devices[2]!,
    ];
    const ui = await openInterface({ state: { devices: bare }, rules });
    await ui.click(ui.byText('button.tab', 'Controllers'));

    // Nothing says what else it could send, so what is bound is all there is.
    expect(table(ui)[0]?.rows).toEqual([
      ['1 Single', 'Woonkamer: Licht cycle'],
      ['1 Single', 'Woonkamer: Alles uit'],
    ]);
  });

  it('says so when nothing is marked as a controller', async () => {
    const ui = await openInterface({ state: { devices: [devices[2]!] }, rules: [] });
    await ui.click(ui.byText('button.tab', 'Controllers'));

    expect(ui.document.querySelector('#controllers .empty')?.textContent).toContain('controller');
  });

  it('has no filter or sort of its own', async () => {
    const ui = await openControllers();

    expect((ui.document.getElementById('filter') as HTMLInputElement).hidden).toBe(true);
    expect((ui.document.getElementById('sort') as HTMLSelectElement).hidden).toBe(true);
  });
});

describe('the overview as a file', () => {
  it('writes a table per controller, free buttons as none', async () => {
    const ui = await openControllers();

    // The download builds the file in the browser, so the text is read off
    // the same function the button hands to it.
    const markdown = ui.window.eval('controllersAsMarkdown()') as string;

    expect(markdown).toContain('## Gang Deur');
    expect(markdown).toContain('## Woonkamer Bank');
    const lines = markdown.split('\n').map((line) => line.replace(/\s+\|/g, ' |'));
    expect(lines).toContain('| 1 Single | Woonkamer: Dimmen (up) |');
    expect(lines).toContain('| 2 Single | _none_ |');
  });

  it('leaves the free buttons out of the file when they are not wanted', async () => {
    const ui = await openControllers();
    const box = ui.document.getElementById('unused-buttons') as HTMLInputElement;
    box.checked = false;
    box.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();

    expect(ui.window.eval('controllersAsMarkdown()') as string).not.toContain('_none_');
  });
});
