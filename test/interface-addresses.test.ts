import { describe, expect, it } from 'vitest';

import { openInterface } from './helpers/interface.js';

const device = (deviceId: string, name: string, exposure: Record<string, unknown>, extra = {}) => ({
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
    {
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
      values: ['single', 'double'],
    },
  ],
  exposure: { properties: [], ...exposure },
  state: {},
  lastSeen: {},
  ...extra,
});

const devices = () => [
  device('0xa', 'hall_lamp', { room: 'Gang', type: 'light' }),
  device('0xb', 'kitchen_lamp', { room: 'Keuken', type: 'light' }),
  device('0xc', 'remote', { room: 'Gang', type: 'controller' }),
];

const ref = (deviceId: string, propertyKey = 'state') => ({ sourceId: 'zigbee', deviceId, propertyKey });
const rules = [
  {
    id: 'r1',
    name: 'Keuken aan',
    enabled: true,
    triggers: [
      { ...ref('0xc', 'action'), match: { kind: 'equals', value: 'single' } },
      { ...ref('0xa'), match: { kind: 'changedTo', value: 'ON' } },
    ],
    branches: [{ actions: [{ ...ref('0xb'), value: 'ON' }] }],
  },
  {
    id: 'r2',
    name: 'Gang aan',
    enabled: true,
    triggers: [{ ...ref('0xb'), match: { kind: 'changedTo', value: 'ON' } }],
    branches: [{ actions: [{ ...ref('0xa'), value: 'ON' }] }],
  },
];

const open = (at: string) => openInterface({ state: { devices: devices() }, rules, at });
const cardsOf = (ui: { document: Document }, id: string) =>
  [...ui.document.querySelectorAll(`[data-link="${id}"]`)] as HTMLDetailsElement[];
const active = (ui: { document: Document }) =>
  ui.document.querySelector('button.tab.active')?.textContent;

describe('an address', () => {
  it('opens the tab it names', async () => {
    const ui = await open('/sliders');
    expect(active(ui)).toBe('Sliders');
  });

  it('names Devices when it names nothing, and says so', async () => {
    const ui = await open('/');
    expect(active(ui)).toBe('Devices');
    expect(ui.window.location.pathname).toBe('/devices');
  });

  it('opens the rule its # names, unfolding the section it is in', async () => {
    const ui = await open('/automation#r2');
    expect(active(ui)).toBe('Automation');
    const [card] = cardsOf(ui, 'r2');
    expect(card!.open).toBe(true);
    // Not the other one.
    expect(cardsOf(ui, 'r1')[0]!.open).toBe(false);
  });

  it('opens a device the same way', async () => {
    const ui = await open(`/devices#${encodeURIComponent('zigbee:0xb')}`);
    expect(cardsOf(ui, 'zigbee:0xb')[0]!.open).toBe(true);
  });

  it('empties a filter that hides what it names, and keeps the sort', async () => {
    const ui = await open('/automation');
    const filter = ui.document.querySelector('#filter') as HTMLInputElement;
    filter.value = 'zolder';
    filter.dispatchEvent(new ui.window.Event('input'));
    const sort = ui.document.querySelector('#sort') as HTMLSelectElement;
    sort.value = 'room';
    sort.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();

    ui.window.history.pushState(null, '', '/automation#r1');
    ui.window.dispatchEvent(new ui.window.PopStateEvent('popstate'));
    await ui.settle();

    expect(filter.value).toBe('');
    expect(sort.value).toBe('room');
    const [card] = cardsOf(ui, 'r1');
    expect(card!.open).toBe(true);
    expect((card!.closest('.section-items') as HTMLElement).hidden).toBe(false);
  });

  it('opens every listing of a rule listed under several triggers', async () => {
    const ui = await open('/automation');
    const sort = ui.document.querySelector('#sort') as HTMLSelectElement;
    sort.value = 'trigger';
    sort.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();

    ui.window.history.pushState(null, '', '/automation#r1');
    ui.window.dispatchEvent(new ui.window.PopStateEvent('popstate'));
    await ui.settle();

    const cards = cardsOf(ui, 'r1');
    expect(cards).toHaveLength(2);
    expect(cards.every((card) => card.open)).toBe(true);
  });
});

describe('the address as things are opened', () => {
  it('follows the tabs, as a step back and forward go through', async () => {
    const ui = await open('/devices');
    const before = ui.window.history.length;
    await ui.click(ui.byText('button.tab', 'Mirror devices'));
    expect(ui.window.location.pathname).toBe('/mirror');
    expect(ui.window.history.length).toBe(before + 1);
  });

  it('carries the # of an opened card, and loses it when the card is closed', async () => {
    const ui = await open('/automation');
    const summary = cardsOf(ui, 'r2')[0]!.querySelector('summary') as HTMLElement;

    summary.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ui.window.location.hash).toBe('#r2');

    summary.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ui.window.location.hash).toBe('');
    expect(ui.window.location.pathname).toBe('/automation');
  });

  it('goes to a rule from the button it is on in Controllers', async () => {
    const ui = await open('/controllers');
    const link = [...ui.document.querySelectorAll('#controllers a.rule-link')].find((node) =>
      node.textContent?.includes('Keuken aan'),
    ) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/automation#r1');

    await ui.click(link);
    expect(active(ui)).toBe('Automation');
    expect(ui.window.location.pathname).toBe('/automation');
    expect(cardsOf(ui, 'r1')[0]!.open).toBe(true);
  });
});
