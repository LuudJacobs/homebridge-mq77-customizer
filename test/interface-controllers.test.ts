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

  it('gives a button two rules answer a row each, saying the button once', async () => {
    const ui = await openControllers();

    // The second row has no button cell of its own: the first spans them both.
    expect(table(ui)[1]?.rows).toEqual([
      ['1 Single', 'Woonkamer: Licht cycle'],
      ['Woonkamer: Alles uit'],
      ['1 Double', 'none'],
      ['2 Single', 'none'],
    ]);

    const spanning = ui.document.querySelector('#controllers td[rowspan]') as HTMLTableCellElement;
    expect(spanning.textContent).toBe('1 Single');
    expect(spanning.rowSpan).toBe(2);
  });

  it('leaves the free buttons out when they are not wanted', async () => {
    const ui = await openControllers();
    const box = ui.document.getElementById('unused-buttons') as HTMLInputElement;
    box.checked = false;
    box.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();

    expect(table(ui)[1]?.rows).toEqual([
      ['1 Single', 'Woonkamer: Licht cycle'],
      ['Woonkamer: Alles uit'],
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
      ['Woonkamer: Alles uit'],
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
    // A button with two answers is written once, and left blank under itself.
    const shared = lines.findIndex((line) => line.includes('Woonkamer: Licht cycle'));
    expect(lines[shared + 1]).toBe('| | Woonkamer: Alles uit |');
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

describe('how wide the button column is', () => {
  it('is one width for every table, as slim as the longest button', async () => {
    const ui = await openControllers();
    const width = (ui.document.getElementById('controllers') as HTMLElement).style.getPropertyValue(
      '--button-column',
    );

    // "1 Double" and "Left Single" are the longest of them, and every table
    // reads down the same column edge.
    expect(width).toBe('9ch');
  });
});

/** What the server says about a remote's buttons: which value is which press. */
const heard = (values: string[]) => {
  const buttons = new Map<string, { name: string; gestures: number[]; unsupported: string[]; events: Record<string, number> }>();
  for (const value of values) {
    const [name, gesture] = value.split('_');
    const press = gesture === 'double' ? 1 : gesture === 'long' ? 2 : 0;
    const button = buttons.get(name!) ?? { name: name!, gestures: [], unsupported: [], events: {} };
    button.events[value] = press;
    button.gestures = [...new Set([...button.gestures, press])].sort();
    buttons.set(name!, button);
  }
  return [...buttons.values()];
};

const published = (over: Record<string, unknown> = {}) => [
  device(
    '0xr',
    'remote_b',
    { label: 'Bank', room: 'Woonkamer', type: 'controller', properties: ['action'], ...over },
    [action({ buttons: heard(['1_single', '1_double', '2_single']) })],
  ),
  devices[2]!,
];

async function openPublished(over: Record<string, unknown> = {}) {
  const ui = await openInterface({ state: { devices: published(over) }, rules });
  await ui.click(ui.byText('button.tab', 'Controllers'));
  return ui;
}

const tick = async (ui: Awaited<ReturnType<typeof openPublished>>, id: string, on: boolean) => {
  const box = ui.document.getElementById(id) as HTMLInputElement;
  box.checked = on;
  box.dispatchEvent(new ui.window.Event('change'));
  await ui.settle();
};

describe('buttons HomeKit hears', () => {
  it('says so instead of calling the button free, and under any rule it has', async () => {
    const ui = await openPublished();

    expect(table(ui)[0]?.rows).toEqual([
      ['1 Single', 'Woonkamer: Licht cycle'],
      ['Woonkamer: Alles uit'],
      ['In HomeKit'],
      ['1 Double', 'In HomeKit'],
      ['2 Single', 'In HomeKit'],
    ]);

    // The button is still said once, over every line it now has.
    const spanning = ui.document.querySelector('#controllers td[rowspan]') as HTMLTableCellElement;
    expect(spanning.rowSpan).toBe(3);
  });

  it('falls back to none when the HomeKit lines are not wanted', async () => {
    const ui = await openPublished();
    await tick(ui, 'homekit-buttons', false);

    expect(table(ui)[0]?.rows).toEqual([
      ['1 Single', 'Woonkamer: Licht cycle'],
      ['Woonkamer: Alles uit'],
      ['1 Double', 'none'],
      ['2 Single', 'none'],
    ]);
  });

  it('drops the button altogether with neither tick', async () => {
    const ui = await openPublished();
    await tick(ui, 'homekit-buttons', false);
    await tick(ui, 'unused-buttons', false);

    expect(table(ui)[0]?.rows).toEqual([
      ['1 Single', 'Woonkamer: Licht cycle'],
      ['Woonkamer: Alles uit'],
    ]);
  });

  it('hears nothing of a property that is not published', async () => {
    const ui = await openPublished({ properties: [] });

    expect(table(ui)[0]?.rows.map((row) => row[row.length - 1])).not.toContain('In HomeKit');
  });

  it('hears nothing of a gesture turned off on its button', async () => {
    // Single press only, so the double is left to the rules engine.
    const ui = await openPublished({ buttons: { action: { 1: [0] } } });

    expect(table(ui)[0]?.rows).toEqual([
      ['1 Single', 'Woonkamer: Licht cycle'],
      ['Woonkamer: Alles uit'],
      ['In HomeKit'],
      ['1 Double', 'none'],
      ['2 Single', 'In HomeKit'],
    ]);
  });

  it('writes the same lines into the file, in italics', async () => {
    const ui = await openPublished();
    const lines = (ui.window.eval('controllersAsMarkdown()') as string)
      .split('\n')
      .map((line) => line.replace(/\s+\|/g, ' |'));

    expect(lines).toContain('| 1 Double | _In HomeKit_ |');
    expect(lines).not.toContain('| 1 Double | _none_ |');
    // Under the rules it answers, with no button written beside it.
    expect(lines[lines.findIndex((line) => line.includes('Alles uit')) + 1]).toBe('| | _In HomeKit_ |');

    await tick(ui, 'homekit-buttons', false);
    const without = ui.window.eval('controllersAsMarkdown()') as string;
    expect(without).not.toContain('_In HomeKit_');
    expect(without).toContain('_none_');
  });

  it('offers both ticks on this tab and nowhere else', async () => {
    const ui = await openPublished();
    const box = ui.document.getElementById('homekit-buttons-filter') as HTMLElement;
    expect(box.hidden).toBe(false);

    await ui.click(ui.byText('button.tab', 'Devices'));
    expect(box.hidden).toBe(true);
  });
});
