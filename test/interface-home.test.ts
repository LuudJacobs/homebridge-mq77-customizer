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
const buttonIn = (row: Element, text: string) =>
  [...row.querySelectorAll('button')].find((button) => button.textContent === text) as HTMLButtonElement;

describe('Home', () => {
  it('opens on Rooms, at an address of its own', async () => {
    const ui = await openRooms();
    expect(ui.document.querySelector('button.tab.active')?.textContent).toBe('Home');
    expect(ui.window.location.pathname).toBe('/home/rooms');
    expect(ui.byText('button.home-link', 'Rooms')?.classList.contains('active')).toBe(true);
  });

  it('lists the rooms A to Z, with what is in each', async () => {
    const ui = await openRooms();
    expect(rows(ui).map((row) => (row.querySelector('input') as HTMLInputElement).value)).toEqual([
      'Bathroom',
      'Kitchen',
      'Zolder',
    ]);
    expect(rows(ui)[1]!.querySelector('.device-meta')?.textContent).toBe('2 devices');
  });

  it('adds a room', async () => {
    const ui = await openRooms();
    await ui.click(ui.document.getElementById('add-room'));
    const fresh = rows(ui)[0]!;
    expect(fresh.classList.contains('new')).toBe(true);
    const input = fresh.querySelector('input') as HTMLInputElement;
    input.value = 'Kelder';
    input.dispatchEvent(new ui.window.Event('input'));
    await ui.click(buttonIn(fresh, 'Add'));
    expect(ui.requests.findLast((request) => request.path === '/api/rooms')?.body).toEqual({
      name: 'Kelder',
    });
  });

  it('renames a room once there is a new name to save', async () => {
    const ui = await openRooms();
    const row = rows(ui)[2]!;
    const save = buttonIn(row, 'Save');
    expect(save.hidden).toBe(true);

    const input = row.querySelector('input') as HTMLInputElement;
    input.value = 'Vliering';
    input.dispatchEvent(new ui.window.Event('input'));
    expect(save.hidden).toBe(false);
    await ui.click(save);
    expect(ui.requests.findLast((request) => request.path === '/api/rooms')?.body).toEqual({
      name: 'Zolder',
      to: 'Vliering',
    });
  });

  it('removes a room, asked twice', async () => {
    const ui = await openRooms();
    const remove = buttonIn(rows(ui)[0]!, 'Delete');
    await ui.click(remove);
    expect(ui.requests.some((request) => request.path === '/api/rooms')).toBe(false);
    await ui.click(remove);
    expect(ui.requests.findLast((request) => request.path === '/api/rooms')?.body).toEqual({
      name: 'Bathroom',
    });
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
