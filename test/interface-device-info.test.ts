import { describe, expect, it } from 'vitest';

import { openInterface } from './helpers/interface.js';

const device = (
  deviceId: string,
  name: string,
  exposure: Record<string, unknown> = {},
  renameable = false,
) => ({
  sourceId: 'zigbee',
  deviceId,
  name,
  topic: `zigbee2mqtt/${name}`,
  manufacturer: 'SONOFF',
  model: 'ZBMINIL2',
  rulesOnly: false,
  renameable,
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

const names = (ui: { document: Document }) =>
  [...ui.document.querySelectorAll('#devices .device-name')].map((node) => node.textContent);

const headings = (ui: { document: Document }) =>
  [...ui.document.querySelectorAll('#devices .rule-group')].map((node) => node.textContent);

async function openDevices(devices: unknown[]) {
  return openInterface({ state: { devices } });
}

async function sortBy(ui: Awaited<ReturnType<typeof openDevices>>, value: string) {
  const sort = ui.document.querySelector('#sort') as HTMLSelectElement;
  sort.value = value;
  sort.dispatchEvent(new ui.window.Event('change'));
  await ui.settle();
}

describe('what a device is called', () => {
  it('uses the source name when nothing is set', async () => {
    const ui = await openDevices([device('0xa', 'hall_lamp')]);
    expect(names(ui)).toEqual(['hall_lamp']);
  });

  it('uses a name of its own when one is given', async () => {
    const ui = await openDevices([device('0xa', 'hall_lamp', { label: 'Reading lamp' })]);
    expect(names(ui)).toEqual(['Reading lamp']);
  });

  it('puts the room in front when both are set', async () => {
    const ui = await openDevices([
      device('0xa', 'hall_lamp', { label: 'Reading lamp', room: 'Study' }),
    ]);
    expect(names(ui)).toEqual(['Study Reading lamp']);
  });

  it('leaves the name alone when only the room is set', async () => {
    // A room is for grouping. A device already called Kitchen in Zigbee2MQTT
    // would otherwise read "Kitchen Kitchen".
    const ui = await openDevices([device('0xa', 'hall_lamp', { room: 'Hall' })]);
    expect(names(ui)).toEqual(['hall_lamp']);
  });
});

describe('the fields on a device', () => {
  it('offers all three, on any device', async () => {
    const ui = await openDevices([device('0xa', 'hall_lamp')]);
    const card = ui.document.querySelector('#devices .device') as HTMLDetailsElement;
    card.open = true;
    await ui.settle();

    // The first child only: the Type field's options are inside its label.
    const labels = [...ui.document.querySelectorAll('.device-field')].map((node) =>
      node.firstChild?.textContent?.trim(),
    );
    expect(labels).toEqual(['Name', 'Room', 'Type']);
  });

  it('sends what was typed', async () => {
    const ui = await openDevices([device('0xa', 'hall_lamp')]);
    const card = ui.document.querySelector('#devices .device') as HTMLDetailsElement;
    card.open = true;
    await ui.settle();

    const room = ui.document.querySelectorAll('.device-field input')[1] as HTMLInputElement;
    room.value = 'Kitchen';
    room.dispatchEvent(new ui.window.Event('change'));
    // Saving is held back a moment, so typing does not send a request a letter.
    await new Promise((resolve) => setTimeout(resolve, 400));

    const saved = ui.requests.findLast((request) => request.path === '/api/exposure')?.body as {
      exposure: { room: string };
    };
    expect(saved.exposure.room).toBe('Kitchen');
  });

  it('has no pencil in the header any more', async () => {
    const ui = await openDevices([device('0xa', 'hall_lamp', {}, true)]);
    expect(ui.document.querySelector('.rename-button')).toBeNull();
  });
});

describe('the type icon', () => {
  it('appears in the header for a device with a type', async () => {
    const ui = await openDevices([device('0xa', 'hall_lamp', { type: 'light' })]);
    const icon = ui.document.querySelector('#devices .type-icon');
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute('class')).toContain('light');
  });

  it('is absent when no type is set', async () => {
    const ui = await openDevices([device('0xa', 'hall_lamp')]);
    expect(ui.document.querySelector('#devices .type-icon')).toBeNull();
  });
});

describe('grouping the device list', () => {
  const devices = [
    device('0xa', 'a_lamp', { room: 'Kitchen', type: 'light' }),
    device('0xb', 'b_lamp', { room: 'Hall', type: 'sensor' }),
    device('0xc', 'c_lamp', {}),
  ];

  it('groups by room, with the unset ones last', async () => {
    const ui = await openDevices(devices);
    await sortBy(ui, 'room');
    expect(headings(ui)).toEqual(['Hall', 'Kitchen', 'Unknown']);
  });

  it('groups by type, naming the kinds rather than their values', async () => {
    const ui = await openDevices(devices);
    await sortBy(ui, 'type');
    expect(headings(ui)).toEqual(['Light', 'Sensor', 'Unknown']);
  });

  it('shows a plain list again when sorted by name', async () => {
    const ui = await openDevices(devices);
    await sortBy(ui, 'name');
    expect(headings(ui)).toEqual([]);
    expect(names(ui)).toHaveLength(3);
  });

  it('finds a device by its room', async () => {
    const ui = await openDevices(devices);
    const filter = ui.document.querySelector('#filter') as HTMLInputElement;
    filter.value = 'kitchen';
    filter.dispatchEvent(new ui.window.Event('input'));
    await ui.settle();

    expect(names(ui)).toEqual(['a_lamp']);
  });

  it('says less in the filter box', async () => {
    const ui = await openDevices(devices);
    expect((ui.document.querySelector('#filter') as HTMLInputElement).placeholder).toBe(
      'Filter...',
    );
  });
});
