import { describe, expect, it } from 'vitest';

import { openInterface } from './helpers/interface.js';

const lamp = () => ({
  sourceId: 'zigbee',
  deviceId: '0xa',
  name: 'hall_lamp',
  topic: 'zigbee2mqtt/hall_lamp',
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
  exposure: { properties: [], room: 'Gang', label: 'Lamp' },
  state: {},
  lastSeen: {},
});

/** A state toggle the way the server lists one. */
const toggle = (deviceId: string, name: string, value: boolean, room?: string) => ({
  sourceId: 'states',
  deviceId,
  name,
  rulesOnly: true,
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
      onValue: true,
      offValue: false,
      toggleValue: 'toggle',
    },
  ],
  exposure: { properties: [], type: 'state', ...(room ? { room } : {}) },
  state: { state: value },
});

/** Fresh each time: the page writes into what it is given, as it does with the server's. */
const devices = () => [lamp(), toggle('t1', 'Away', false, 'Gang'), toggle('t2', 'Guests', true)];

const cardOf = (ui: { document: Document }, name: string) =>
  [...ui.document.querySelectorAll('#devices .device')].find(
    (card) => card.querySelector('.device-name')?.textContent === name,
  ) as HTMLDetailsElement;

const fieldOf = (card: Element, label: string) =>
  [...card.querySelectorAll('.device-field')]
    .find((field) => field.firstChild?.textContent === label)
    ?.querySelector('input, select') as HTMLInputElement & HTMLSelectElement;

describe('a state toggle in the device list', () => {
  it('is drawn as its own kind, says where it stands, and is rules only', async () => {
    const ui = await openInterface({ state: { devices: devices() } });
    // Named with its room, the way a device with a name of its own is.
    const card = cardOf(ui, 'Gang Away');

    expect(card.querySelector('summary svg.type-icon.state title')?.textContent).toBe(
      'State toggle',
    );
    expect(card.querySelector('.device-seen')?.textContent).toBe('false');
    expect(card.querySelector('summary .badge')?.textContent).toBe('rules only');
  });

  it('opens on its name, room and value, with nothing for HomeKit', async () => {
    const ui = await openInterface({ state: { devices: devices() } });
    const card = cardOf(ui, 'Gang Away');
    await ui.openCard(card);

    expect(fieldOf(card, 'Name').value).toBe('Away');
    expect(fieldOf(card, 'Room').value).toBe('Gang');
    expect([...fieldOf(card, 'Value').options].map((option) => option.value)).toEqual([
      'false',
      'true',
    ]);
    expect(fieldOf(card, 'Value').value).toBe('false');
    expect(fieldOf(card, 'Type')).toBeUndefined();
    expect(card.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(ui.byText('button.danger', 'Delete', '#devices')).not.toBeNull();
  });

  it('is renamed and flipped through the toggles, and given a room like any device', async () => {
    const ui = await openInterface({ state: { devices: devices() } });
    const card = cardOf(ui, 'Gang Away');
    await ui.openCard(card);

    const name = fieldOf(card, 'Name');
    name.value = ' Weg ';
    name.dispatchEvent(new ui.window.Event('change'));
    const value = fieldOf(card, 'Value');
    value.value = 'true';
    value.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();

    const toToggle = ui.requests.filter((request) => request.path === '/api/states/t1');
    expect(toToggle.map((request) => request.body)).toEqual([{ name: 'Weg' }, { value: true }]);

    const room = fieldOf(cardOf(ui, 'Gang Weg'), 'Room');
    room.value = 'Hal';
    room.dispatchEvent(new ui.window.Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await ui.settle();
    const saved = ui.requests.findLast((request) => request.path === '/api/exposure')?.body as {
      deviceId: string;
      exposure: { room?: string };
    };
    expect(saved).toMatchObject({ deviceId: 't1', exposure: { room: 'Hal' } });
  });

  it('keeps its name when the box is emptied', async () => {
    const ui = await openInterface({ state: { devices: devices() } });
    const card = cardOf(ui, 'Gang Away');
    await ui.openCard(card);

    const name = fieldOf(card, 'Name');
    name.value = '  ';
    name.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();

    expect(name.value).toBe('Away');
    expect(ui.requests.some((request) => request.path === '/api/states/t1')).toBe(false);
  });

  it('follows a change made somewhere else', async () => {
    const ui = await openInterface({ state: { devices: devices() } });
    const card = cardOf(ui, 'Gang Away');
    await ui.openCard(card);

    await ui.live({ type: 'state', sourceId: 'states', deviceId: 't1', changes: { state: true } });
    expect(card.querySelector('.device-seen')?.textContent).toBe('true');
    expect(fieldOf(card, 'Value').value).toBe('true');
  });

  it('asks twice before it is deleted', async () => {
    const ui = await openInterface({ state: { devices: devices() } });
    const card = cardOf(ui, 'Gang Away');
    await ui.openCard(card);

    const remove = ui.byText('button.danger', 'Delete', '#devices');
    await ui.click(remove);
    expect(ui.requests.some((request) => request.path === '/api/states/t1')).toBe(false);
    await ui.click(remove);
    expect(ui.requests.some((request) => request.path === '/api/states/t1')).toBe(true);
  });

  it('is not a kind another device can be', async () => {
    const ui = await openInterface({ state: { devices: devices() } });
    const card = cardOf(ui, 'Gang Lamp');
    await ui.openCard(card);
    const kinds = [...fieldOf(card, 'Type').options].map((option) => option.textContent);
    expect(kinds).not.toContain('State toggle');
  });
});

describe('adding a state toggle', () => {
  it('makes one from the devices tab and opens it to be named', async () => {
    const ui = await openInterface({ state: { devices: devices() } });
    ui.responses['POST /api/states'] = { id: 't3' };
    ui.responses['/api/state'] = {
      tileTypes: [],
      devices: [...devices(), toggle('t3', 'New state toggle', false)],
    };

    await ui.click(ui.byText('#view-devices button', '+ state toggle'));

    expect(ui.requests.some((request) => request.path === '/api/states')).toBe(true);
    const card = cardOf(ui, 'New state toggle');
    expect(card.open).toBe(true);
    expect(ui.document.activeElement).toBe(fieldOf(card, 'Name'));

    // Nothing in it yet, so nothing to ask twice about.
    await ui.click(card.querySelector('button.danger'));
    expect(ui.requests.some((request) => request.path === '/api/states/t3')).toBe(true);
  });
});

describe('a state toggle in rules', () => {
  const rule = {
    id: 'r1',
    name: 'Weg',
    enabled: true,
    triggers: [
      { sourceId: 'zigbee', deviceId: '0xa', propertyKey: 'state', match: { kind: 'changedTo', value: 'ON' } },
    ],
    branches: [{ actions: [{ sourceId: 'states', deviceId: 't1', propertyKey: 'state', value: 'toggle' }] }],
  };

  async function openRule() {
    const ui = await openInterface({ state: { devices: devices() }, rules: [rule] });
    await ui.click(ui.byText('button.tab', 'Automation'));
    await ui.openCard(ui.document.querySelector('.rule') as HTMLDetailsElement);
    return ui;
  }

  it('is listed under its own room, and under Unknown without one', async () => {
    const ui = await openRule();
    const row = ui.document.querySelector('.actions .rule-row')!;
    const room = row.querySelector('.room-picker') as HTMLSelectElement;
    const device = row.querySelector('.device-picker') as HTMLSelectElement;

    expect(room.value).toBe('Gang');
    expect([...device.options].map((option) => option.textContent)).toEqual(['Away', 'Lamp']);

    room.value = '__unroomed';
    room.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();
    expect([...device.options].map((option) => option.textContent)).toEqual(['Guests']);
  });

  it('can be set to true or false, or flipped', async () => {
    const ui = await openRule();
    const row = ui.document.querySelector('.actions .rule-row')!;
    const values = [...row.querySelectorAll('.rule-tail select')].at(-1) as HTMLSelectElement;
    expect([...values.options].map((option) => option.value)).toEqual(['true', 'false', 'toggle']);
    expect(values.value).toBe('toggle');
  });
});

describe('a state toggle in the activity log', () => {
  const log = [
    {
      at: Date.now(),
      ruleId: 'states:t1',
      ruleName: 'Away',
      ruleKind: 'state',
      outcome: 'fired',
      detail: 'Away true (by hand)',
      changed: { sourceId: 'states', deviceId: 't1', propertyKey: 'state', value: 'true' },
      byHand: true,
    },
  ];

  it('reads as the toggle and where it stands, with who did it', async () => {
    const ui = await openInterface({ state: { devices: devices() }, log });
    await ui.click(ui.byText('button.tab', 'Activity'));

    const line = ui.document.querySelector('#activity-log .log-line')!;
    expect(line.querySelector('.tag')?.textContent).toBe('state toggle');
    const what = line.querySelector('.log-what')!;
    // With its kind drawn in front, the way every device in the log is.
    expect(what.querySelector('svg.type-icon.state')).not.toBeNull();
    what.querySelectorAll('title').forEach((title) => title.remove());
    expect(what.textContent).toBe('Gang Away: true (by hand)');
  });

  it('has a filter of its own, on to begin with', async () => {
    const ui = await openInterface({ state: { devices: devices() }, log });
    await ui.click(ui.byText('button.tab', 'Activity'));
    const box = ui.document.getElementById('kind-state') as HTMLInputElement;
    expect(box.checked).toBe(true);

    box.checked = false;
    box.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();
    expect(ui.document.querySelector('#activity-log .log-line')).toBeNull();
  });
});
