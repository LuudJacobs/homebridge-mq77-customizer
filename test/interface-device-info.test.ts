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
    await ui.openCard(card);

    // The first child only: the Type field's options are inside its label.
    const labels = [...ui.document.querySelectorAll('.device-field')].map((node) =>
      node.firstChild?.textContent?.trim(),
    );
    expect(labels).toEqual(['Name', 'Room', 'Type']);
  });

  it('sends what was typed', async () => {
    const ui = await openDevices([device('0xa', 'hall_lamp')]);
    const card = ui.document.querySelector('#devices .device') as HTMLDetailsElement;
    await ui.openCard(card);

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

  it('offers every kind, including the ones added later', async () => {
    const ui = await openDevices(devices);
    const card = ui.document.querySelector('#devices .device') as HTMLDetailsElement;
    await ui.openCard(card);

    // Every card builds its panel, open or not, so ask this one only.
    const kinds = [...card.querySelectorAll('.device-field select option')].map(
      (node) => node.textContent,
    );
    expect(kinds).toEqual([
      'Not set',
      'Light',
      'Sensor',
      'Controller',
      'Fan',
      'TV',
      'Audio device',
      'Media device',
      'Other',
    ]);
  });

  it('draws something for each of them', async () => {
    for (const type of [
      'light',
      'sensor',
      'controller',
      'fan',
      'tv',
      'audio',
      'media',
      'other',
    ]) {
      const ui = await openDevices([device('0xa', 'thing', { type })]);
      const icon = ui.document.querySelector('#devices .type-icon');
      expect(icon, type).not.toBeNull();
      expect(icon!.querySelectorAll('path').length, type).toBeGreaterThan(0);
    }
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

describe('what a panel says about the device itself', () => {
  const facts = (ui: { document: Document }) =>
    [...ui.document.querySelectorAll('#devices .property.fact')].map((row) => [
      row.querySelector('.fact-label')?.textContent,
      row.querySelector('.value')?.textContent,
    ]);

  it('puts what the device is and where it lives on the first line of the panel', async () => {
    const ui = await openDevices([device('0x1', 'hall_switch')]);
    const origin = ui.document.querySelector('#devices .device-origin');

    expect([...origin!.children].map((node) => node.textContent)).toEqual([
      'SONOFF ZBMINIL2',
      '|',
      'zigbee2mqtt/hall_switch',
    ]);
    // And off the header, which now carries only the name, when it was last
    // heard, and what it became in HomeKit.
    expect(ui.document.querySelector('#devices summary .device-meta')).toBeNull();
    expect(ui.document.querySelector('#devices summary .device-topic')).toBeNull();
  });

  it('says under diagnostics whether the device is retained', async () => {
    const ui = await openDevices([{ ...device('0x1', 'hall_switch'), retained: true }]);

    expect(facts(ui)).toEqual([['retained', 'true']]);
    // The heading appears for the fact alone: this device has no diagnostic
    // function of its own.
    expect(
      [...ui.document.querySelectorAll('#devices .group-title')].map((node) => node.textContent),
    ).toContain('Diagnostics');
  });

  it('says false as plainly as true, and nothing at all when the source cannot say', async () => {
    const off = await openDevices([{ ...device('0x1', 'hall_switch'), retained: false }]);
    expect(facts(off)).toEqual([['retained', 'false']]);

    const silent = await openDevices([device('0x1', 'hall_switch')]);
    expect(facts(silent)).toEqual([]);
  });

  it('gives the timestamp itself, since the header has said it readably', async () => {
    const ui = await openDevices([
      {
        ...device('0x1', 'hall_switch'),
        retained: true,
        reportedLastSeen: '2026-08-25T09:00:00Z',
      },
    ]);

    // The place to check the thing itself, so it is repeated as it came off
    // the wire, with the readable version on hover.
    expect(facts(ui)).toContainEqual(['last seen', '2026-08-25T09:00:00Z']);
    expect(
      ui.document.querySelector('#devices .property.fact[title]')?.getAttribute('title'),
    ).toBeTruthy();
  });

  it('says in the header when the device was last heard, and nothing where it never says', async () => {
    const said = await openDevices([
      { ...device('0x1', 'hall_switch'), reportedLastSeen: '2026-08-25T09:00:00Z' },
    ]);
    // Readable there, rather than the timestamp: `25-08 11:00` or, on the day
    // itself, `Today 11:00:00`.
    const shown = said.document.querySelector('#devices .device-seen')?.textContent ?? '';
    expect(shown).not.toBe('');
    expect(shown).not.toContain('2026-08-25T09:00:00Z');

    // A device publishing no time of its own leaves the header empty: when a
    // message reached the broker is not an answer to when the device spoke.
    const silent = await openDevices([device('0x2', 'attic_sensor')]);
    expect(silent.document.querySelector('#devices .device-seen')?.textContent).toBe('');
  });
});

describe('the order functions are listed in', () => {
  const mixed = () => ({
    ...device('0x9', 'mixed_device'),
    properties: [
      { key: 'state', label: 'State', semantic: 'state', type: 'binary', category: 'primary', endpoint: '', readable: true, writable: true, publishable: true, role: 'power', onValue: 'ON', offValue: 'OFF' },
      { key: 'brightness', label: 'Brightness', semantic: 'brightness', type: 'numeric', category: 'primary', endpoint: '', readable: true, writable: true, publishable: true, role: 'brightness', min: 0, max: 254 },
      { key: 'linkquality', label: 'Link quality', semantic: 'linkquality', type: 'numeric', category: 'diagnostic', endpoint: '', readable: true, writable: false, publishable: false },
      { key: 'battery', label: 'Battery', semantic: 'battery', type: 'numeric', category: 'diagnostic', endpoint: '', readable: true, writable: false, publishable: true, role: 'battery' },
      { key: 'power_on_behavior', label: 'Power on behaviour', semantic: 'power_on_behavior', type: 'enum', category: 'config', endpoint: '', readable: true, writable: true, publishable: false, values: ['on', 'off'] },
      { key: 'child_lock', label: 'Child lock', semantic: 'child_lock', type: 'binary', category: 'config', endpoint: '', readable: true, writable: true, publishable: true, role: 'childLock', onValue: 'LOCK', offValue: 'UNLOCK' },
    ],
  });

  it('lists each group by name, whatever order the source gave them in', async () => {
    const ui = await openDevices([mixed()]);
    const keys = [...ui.document.querySelectorAll('#devices .property .key')].map(
      (node) => node.textContent,
    );

    // Functions, then Settings, then Diagnostics, each one alphabetical.
    expect(keys).toEqual([
      'brightness',
      'state',
      'child_lock',
      'power_on_behavior',
      'battery',
      'linkquality',
    ]);
  });
});
