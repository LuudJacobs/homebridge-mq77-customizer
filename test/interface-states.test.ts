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

/** An internal state the way the server lists one. */
const property = (type: string) =>
  type === 'text'
    ? { type: 'text' }
    : type === 'number'
      ? { type: 'numeric', step: 1 }
      : { type: 'binary', onValue: true, offValue: false, toggleValue: 'toggle' };

const typed = (deviceId: string, name: string, type: string, value: unknown) => {
  const made = toggle(deviceId, name, false);
  Object.assign(made.properties[0]!, property(type));
  for (const key of ['onValue', 'offValue', 'toggleValue']) {
    if (type !== 'boolean') {
      delete (made.properties[0] as Record<string, unknown>)[key];
    }
  }
  made.state = { state: value as never };
  return made;
};

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

describe('an internal state in the device list', () => {
  it('is drawn as its own kind, says where it stands, and is rules only', async () => {
    const ui = await openInterface({ state: { devices: devices() } });
    // Named with its room, the way a device with a name of its own is.
    const card = cardOf(ui, 'Gang Away');

    expect(card.querySelector('summary svg.type-icon.state title')?.textContent).toBe(
      'Internal state',
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
    expect([...fieldOf(card, 'Type').options].map((option) => option.textContent)).toEqual([
      'Boolean',
      'Text',
      'Number',
    ]);
    expect(fieldOf(card, 'Type').value).toBe('boolean');
    expect(card.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(ui.byText('button.danger', 'Delete', '#devices')).not.toBeNull();
  });

  it('is renamed, flipped and given a room on Save, and not before', async () => {
    const ui = await openInterface({ state: { devices: devices() } });
    const card = cardOf(ui, 'Gang Away');
    await ui.openCard(card);

    const name = fieldOf(card, 'Name');
    name.value = ' Weg ';
    name.dispatchEvent(new ui.window.Event('input'));
    const value = fieldOf(card, 'Value');
    value.value = 'true';
    value.dispatchEvent(new ui.window.Event('change'));
    const room = fieldOf(card, 'Room');
    room.value = 'Hal';
    room.dispatchEvent(new ui.window.Event('input'));
    await ui.settle();
    expect(ui.requests.some((request) => request.path.startsWith('/api/states/'))).toBe(false);
    expect(ui.requests.some((request) => request.path === '/api/exposure')).toBe(false);

    await ui.click(card.querySelector('.rule-footer button.primary'));

    const toToggle = ui.requests.filter((request) => request.path === '/api/states/t1');
    expect(toToggle.map((request) => request.body)).toEqual([{ name: 'Weg', value: true }]);
    const saved = ui.requests.findLast((request) => request.path === '/api/exposure')?.body as {
      deviceId: string;
      exposure: { room?: string };
    };
    expect(saved).toMatchObject({ deviceId: 't1', exposure: { room: 'Hal' } });
  });

  it('will not save without a name', async () => {
    const ui = await openInterface({ state: { devices: devices() } });
    const card = cardOf(ui, 'Gang Away');
    await ui.openCard(card);

    const name = fieldOf(card, 'Name');
    name.value = '  ';
    name.dispatchEvent(new ui.window.Event('input'));
    await ui.click(card.querySelector('.rule-footer button.primary'));

    expect(card.querySelector('.rule-footer .error')?.textContent).toBe('It needs a name');
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

    const remove = card.querySelector('button.danger');
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
    expect(kinds).not.toContain('Internal state');
  });
});

describe('adding an internal state', () => {
  it('makes one from the devices tab and opens it to be named', async () => {
    const ui = await openInterface({ state: { devices: devices() } });
    ui.responses['POST /api/states'] = { id: 't3' };
    ui.responses['/api/state'] = {
      tileTypes: [],
      devices: [...devices(), toggle('t3', 'New state toggle', false)],
    };

    await ui.click(ui.byText('#view-devices button', '+ internal state'));

    expect(ui.requests.some((request) => request.path === '/api/states')).toBe(true);
    const card = cardOf(ui, 'New state toggle');
    expect(card.open).toBe(true);
    expect(ui.document.activeElement).toBe(fieldOf(card, 'Name'));

    // Nothing in it yet, so nothing to ask twice about.
    await ui.click(card.querySelector('button.danger'));
    expect(ui.requests.some((request) => request.path === '/api/states/t3')).toBe(true);
  });
});

describe('an internal state in rules', () => {
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

describe('an internal state in the activity log', () => {
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
    expect(line.querySelector('.tag')?.textContent).toBe('internal state');
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

describe('the type of an internal state', () => {
  it('is changed on the card, starting the value again, and saved with it', async () => {
    const ui = await openInterface({ state: { devices: devices() } });
    const card = cardOf(ui, 'Gang Away');
    await ui.openCard(card);

    const type = fieldOf(card, 'Type');
    type.value = 'number';
    type.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();
    const value = fieldOf(card, 'Value');
    expect(value.type).toBe('number');
    expect(value.value).toBe('0');

    value.value = '-3';
    value.dispatchEvent(new ui.window.Event('input'));
    await ui.click(card.querySelector('.rule-footer button.primary'));
    expect(ui.requests.findLast((request) => request.path === '/api/states/t1')?.body).toEqual({
      name: 'Away',
      type: 'number',
      value: -3,
    });
  });

  it('drops what a Text state cannot hold as it is typed', async () => {
    const ui = await openInterface({
      state: { devices: [...devices(), typed('t3', 'Modus', 'text', 'thuis')] },
    });
    const card = cardOf(ui, 'Modus');
    await ui.openCard(card);

    const value = fieldOf(card, 'Value');
    expect(value.value).toBe('thuis');
    value.value = 'film avond!-en_meer';
    value.dispatchEvent(new ui.window.Event('input'));
    expect(value.value).toBe('filmavond-en');
  });
});

describe('Text and Number states in rules', () => {
  const states = () => [
    ...devices(),
    typed('t3', 'Modus', 'text', 'thuis'),
    typed('t4', 'Gasten', 'number', 2),
  ];
  const ref = (deviceId: string) => ({ sourceId: 'states', deviceId, propertyKey: 'state' });

  async function openRule(rule: unknown) {
    const ui = await openInterface({ state: { devices: states() }, rules: [rule] });
    await ui.click(ui.byText('button.tab', 'Automation'));
    await ui.openCard(ui.document.querySelector('.rule') as HTMLDetailsElement);
    return ui;
  }
  const rule = (trigger: unknown, action: unknown) => ({
    id: 'r1',
    name: 'Regel',
    enabled: true,
    triggers: [trigger],
    branches: [{ actions: [action] }],
  });
  const selects = (row: Element) =>
    [...row.querySelectorAll('.rule-tail select')] as HTMLSelectElement[];
  const texts = (select: HTMLSelectElement) => [...select.options].map((option) => option.textContent);

  it('asks a Text state whether it becomes, matches or contains something', async () => {
    const ui = await openRule(
      rule({ ...ref('t3'), match: { kind: 'contains', value: 'film' } }, { ...ref('t4'), value: 1 }),
    );
    const [kinds] = selects(ui.document.querySelector('.triggers .rule-row')!);
    expect(texts(kinds!)).toEqual(['becomes', 'matches', 'contains', 'changes']);
    expect(kinds!.value).toBe('contains');
  });

  it('only sets a Text state, keeping to what it can hold', async () => {
    const ui = await openRule(
      rule({ ...ref('t4'), match: { kind: 'changed' } }, { ...ref('t3'), value: 'film' }),
    );
    const row = ui.document.querySelector('.actions .rule-row')!;
    const [mode] = selects(row);
    expect(texts(mode!)).toEqual(['set to']);
    const value = row.querySelector('.rule-tail input:not(.delay)') as HTMLInputElement;
    value.value = 'twee woorden';
    value.dispatchEvent(new ui.window.Event('input'));
    expect(value.value).toBe('tweewoorden');
  });

  it('sets a Number state, or counts it up or down', async () => {
    const ui = await openRule(
      rule({ ...ref('t3'), match: { kind: 'changed' } }, { ...ref('t4'), value: 3 }),
    );
    const [mode] = selects(ui.document.querySelector('.actions .rule-row')!);
    expect(texts(mode!)).toEqual(['set to', 'increase by', 'decrease by']);
  });

  it('leaves Text and Number states out of mirrors', async () => {
    const ui = await openInterface({
      state: { devices: states() },
      rules: [{ id: 'm1', kind: 'mirror', name: 'Samen', enabled: true, groups: [] }],
    });
    await ui.click(ui.byText('button.tab', 'Mirror devices'));
    await ui.openCard(ui.document.querySelector('#mirror .rule') as HTMLDetailsElement);
    const offered = [...ui.document.querySelectorAll('#mirror .mirror-devices label')].map(
      (label) => label.textContent,
    );
    expect(offered).toContain('Gang Away');
    expect(offered).not.toContain('Modus');
    expect(offered).not.toContain('Gasten');
  });
});
