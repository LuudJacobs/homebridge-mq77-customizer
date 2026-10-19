import { describe, expect, it } from 'vitest';

import { openInterface } from './helpers/interface.js';

const device = (deviceId: string, name: string, exposure: Record<string, unknown>) => ({
  sourceId: 'zigbee',
  deviceId,
  name,
  topic: `zigbee2mqtt/${name}`,
  manufacturer: 'SONOFF',
  model: 'ZBMINIL2',
  rulesOnly: false,
  renameable: false,
  endpoints: [''],
  properties: [
    {
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
    },
  ],
  exposure: { properties: [], ...exposure },
  state: {},
  lastSeen: {},
});

const devices = () => [
  device('0xa', 'a_lamp', { room: 'Keuken', type: 'light' }),
  device('0xb', 'b_lamp', { room: 'Keuken', type: 'light' }),
  device('0xc', 'c_lamp', { room: 'Gang', type: 'light' }),
  device('0xd', 'd_new', {}),
];

async function open() {
  const ui = await openInterface({ state: { devices: devices() } });
  const sort = ui.document.querySelector('#sort') as HTMLSelectElement;
  sort.value = 'room';
  sort.dispatchEvent(new ui.window.Event('change'));
  await ui.settle();
  return ui;
}

const heading = (ui: { document: Document }, startsWith: string) =>
  [...ui.document.querySelectorAll('#devices h3.section-title')].find((node) =>
    node.textContent?.startsWith(startsWith),
  ) as HTMLElement;
const items = (title: HTMLElement) => title.nextElementSibling as HTMLElement;
const isOpen = (title: HTMLElement) => !items(title).hidden;

describe('a section of a list', () => {
  it('says how many are in it', async () => {
    const ui = await open();
    const titles = [...ui.document.querySelectorAll('#devices h3.section-title')].map(
      (node) => node.textContent,
    );
    expect(titles).toEqual(['Unknown Devices (1)', 'Gang (1)', 'Keuken (2)']);
  });

  it('starts closed, except the devices nobody has given a kind', async () => {
    const ui = await open();
    expect(isOpen(heading(ui, 'Unknown Devices'))).toBe(true);
    expect(isOpen(heading(ui, 'Gang'))).toBe(false);
    expect(isOpen(heading(ui, 'Keuken'))).toBe(false);
    expect(heading(ui, 'Keuken').classList.contains('open')).toBe(false);
  });

  it('opens and closes on a click anywhere on the heading, turning its triangle', async () => {
    const ui = await open();
    await ui.click(heading(ui, 'Keuken'));
    expect(isOpen(heading(ui, 'Keuken'))).toBe(true);
    expect(heading(ui, 'Keuken').classList.contains('open')).toBe(true);
    expect(items(heading(ui, 'Keuken')).querySelectorAll('.device')).toHaveLength(2);

    await ui.click(heading(ui, 'Keuken'));
    expect(isOpen(heading(ui, 'Keuken'))).toBe(false);
  });

  it('is found as it was left after switching tab and sort', async () => {
    const ui = await open();
    await ui.click(heading(ui, 'Keuken'));
    await ui.click(heading(ui, 'Unknown Devices'));

    await ui.click(ui.byText('button.tab', 'Automation'));
    await ui.click(ui.byText('button.tab', 'Devices'));
    const sort = ui.document.querySelector('#sort') as HTMLSelectElement;
    sort.value = 'type';
    sort.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();
    sort.value = 'room';
    sort.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();

    expect(isOpen(heading(ui, 'Keuken'))).toBe(true);
    expect(isOpen(heading(ui, 'Unknown Devices'))).toBe(false);
    expect(isOpen(heading(ui, 'Gang'))).toBe(false);
  });

  it('shows open while a filter finds something in it, and closes again after', async () => {
    const ui = await open();
    const filter = ui.document.querySelector('#filter') as HTMLInputElement;
    filter.value = 'lamp';
    filter.dispatchEvent(new ui.window.Event('input'));
    await ui.settle();
    expect(isOpen(heading(ui, 'Keuken'))).toBe(true);
    expect(isOpen(heading(ui, 'Gang'))).toBe(true);

    filter.value = '';
    filter.dispatchEvent(new ui.window.Event('input'));
    await ui.settle();
    expect(isOpen(heading(ui, 'Keuken'))).toBe(false);
  });

  it('folds rule lists the same way', async () => {
    const rule = {
      id: 'r1',
      name: 'Licht',
      enabled: true,
      triggers: [{ sourceId: 'zigbee', deviceId: '0xc', propertyKey: 'state', match: { kind: 'changedTo', value: 'ON' } }],
      branches: [{ actions: [{ sourceId: 'zigbee', deviceId: '0xa', propertyKey: 'state', value: 'ON' }] }],
    };
    const ui = await openInterface({ state: { devices: devices() }, rules: [rule] });
    await ui.click(ui.byText('button.tab', 'Automation'));
    const sort = ui.document.querySelector('#sort') as HTMLSelectElement;
    sort.value = 'room';
    sort.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();

    const title = ui.document.querySelector('#automation h3.section-title') as HTMLElement;
    expect(title.textContent).toBe('Keuken (1)');
    expect(isOpen(title)).toBe(false);
    await ui.click(title);
    expect(isOpen(ui.document.querySelector('#automation h3.section-title') as HTMLElement)).toBe(true);
  });
});
