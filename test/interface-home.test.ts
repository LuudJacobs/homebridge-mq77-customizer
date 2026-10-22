import { describe, expect, it } from 'vitest';

import { openInterface } from './helpers/interface.js';

const device = (deviceId: string, name: string, room?: string) => ({
  sourceId: 'zigbee',
  deviceId,
  name,
  topic: `zigbee2mqtt/${name}`,
  manufacturer: 'IKEA',
  model: 'E1743',
  rulesOnly: false,
  renameable: false,
  endpoints: [''],
  properties: [],
  exposure: { properties: [], type: 'light', ...(room ? { room } : {}) },
  state: {},
  lastSeen: {},
});

const devices = () => [device('0xa', 'a_lamp', 'Kitchen'), device('0xb', 'b_lamp', 'Kitchen'), device('0xc', 'c_lamp')];

async function openRooms() {
  const ui = await openInterface({
    state: { devices: devices(), rooms: ['Bathroom', 'Kitchen', 'Zolder'] },
    at: '/home',
  });
  return ui;
}

const rows = (ui: { document: Document }) =>
  [...ui.document.querySelectorAll('#rooms .room-row')] as HTMLElement[];
const button = (ui: { document: Document }, text: string) =>
  [...ui.document.querySelectorAll('#home-page-rooms button')].find(
    (node) => node.textContent === text,
  ) as HTMLButtonElement | undefined;
const inputs = (ui: { document: Document }) =>
  [...ui.document.querySelectorAll('#rooms input')] as HTMLInputElement[];
const saved = (ui: { requests: { path: string; body: unknown }[] }) =>
  ui.requests.findLast((request) => request.path === '/api/rooms')?.body;

async function edit(ui: Awaited<ReturnType<typeof openRooms>>) {
  await ui.click(button(ui, 'Edit rooms')!);
}

describe('Home', () => {
  it('opens on Rooms, at an address of its own', async () => {
    const ui = await openRooms();
    expect(ui.document.querySelector('button.tab.active')?.textContent).toBe('Home');
    expect(ui.window.location.pathname).toBe('/home/rooms');
    expect(ui.byText('button.home-link', 'Rooms')?.classList.contains('active')).toBe(true);
  });

  it('lists the rooms A to Z, with what is in each, and nothing to type in', async () => {
    const ui = await openRooms();
    expect(rows(ui).map((row) => row.querySelector('.room-name')?.textContent)).toEqual([
      'Bathroom',
      'Kitchen',
      'Zolder',
    ]);
    expect(rows(ui)[1]!.querySelector('.device-meta')?.textContent).toBe('2 devices');
    expect(inputs(ui)).toHaveLength(0);
    expect(button(ui, 'Edit rooms')).toBeDefined();
    expect(button(ui, 'Save')).toBeUndefined();
  });

  it('turns into a form on Edit rooms, with Save and, once changed, Revert', async () => {
    const ui = await openRooms();
    await edit(ui);
    expect(inputs(ui).map((input) => input.value)).toEqual(['Bathroom', 'Kitchen', 'Zolder']);
    expect(ui.document.querySelectorAll('#rooms .device-meta')).toHaveLength(0);
    expect(button(ui, 'Edit rooms')).toBeUndefined();
    expect(button(ui, 'Revert')!.hidden).toBe(true);

    inputs(ui)[2]!.value = 'Vliering';
    inputs(ui)[2]!.dispatchEvent(new ui.window.Event('input'));
    expect(button(ui, 'Revert')!.hidden).toBe(false);

    // Revert on the left of Save.
    const order = [...ui.document.querySelectorAll('#rooms-buttons button')].map((node) => node.textContent);
    expect(order).toEqual(['Revert', 'Save']);

    await ui.click(button(ui, 'Revert')!);
    expect(inputs(ui)[2]!.value).toBe('Zolder');
  });

  it('saves the whole form at once, and goes back to the list', async () => {
    const ui = await openRooms();
    await edit(ui);

    inputs(ui)[1]!.value = 'Keuken';
    inputs(ui)[1]!.dispatchEvent(new ui.window.Event('input'));
    // Removed from the form only, asked twice.
    const remove = rows(ui)[0]!.querySelector('button.danger') as HTMLButtonElement;
    await ui.click(remove);
    expect(inputs(ui)).toHaveLength(3);
    await ui.click(remove);
    expect(inputs(ui)).toHaveLength(2);
    expect(ui.requests.some((request) => request.path === '/api/rooms')).toBe(false);

    await ui.click(ui.byText('#rooms button.add-row', '+ room'));
    inputs(ui)[2]!.value = 'Kelder';
    inputs(ui)[2]!.dispatchEvent(new ui.window.Event('input'));

    await ui.click(button(ui, 'Save')!);
    expect(saved(ui)).toEqual({
      rooms: [{ was: 'Kitchen', name: 'Keuken' }, { was: 'Zolder', name: 'Zolder' }, { name: 'Kelder' }],
    });
    expect(button(ui, 'Edit rooms')).toBeDefined();
    expect(inputs(ui)).toHaveLength(0);
  });

  it('asks before the page is left with the form unsaved', async () => {
    const ui = await openRooms();
    await edit(ui);
    inputs(ui)[0]!.value = 'Badkamer';
    inputs(ui)[0]!.dispatchEvent(new ui.window.Event('input'));
    const event = new ui.window.Event('beforeunload', { cancelable: true });
    ui.window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe('the dropdown that stands in for the tabs', () => {
  it('goes to a page of Home', async () => {
    const ui = await openInterface({ state: { devices: devices() } });
    const select = ui.document.querySelector('#tab-select') as HTMLSelectElement;
    select.value = 'home:map';
    select.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();
    expect(ui.window.location.pathname).toBe('/home/zigbee-map');
    expect((ui.document.getElementById('home-page-map') as HTMLElement).hidden).toBe(false);

    select.value = 'home:rooms';
    select.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();
    expect(ui.window.location.pathname).toBe('/home/rooms');
  });
});

describe('the room of a device', () => {
  it('is picked from the rooms, A to Z, or none', async () => {
    const ui = await openInterface({
      state: { devices: devices(), rooms: ['Kitchen', 'Bathroom', 'Zolder'].sort() },
    });
    const card = ui.document.querySelector('#devices [data-link]') as HTMLDetailsElement;
    await ui.openCard(card);
    const room = card.querySelector('select.room-select') as HTMLSelectElement;
    expect([...room.options].map((option) => option.textContent)).toEqual([
      'none',
      'Bathroom',
      'Kitchen',
      'Zolder',
    ]);
  });
});
