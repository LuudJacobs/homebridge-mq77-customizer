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
  exposure: { properties: [], room: 'Gang', label: 'Lamp', type: 'light' },
  state: {},
  lastSeen: {},
});

/** A state the way the server lists one: in no room, and its own kind. */
const toggle = (deviceId: string, name: string, value: boolean | number) => ({
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
      category: 'primary',
      endpoint: '',
      readable: true,
      writable: true,
      publishable: true,
      ...(typeof value === 'number'
        ? { type: 'numeric', step: 1 }
        : {
            semantic: 'state',
            type: 'binary',
            role: 'power',
            onValue: true,
            offValue: false,
            toggleValue: 'toggle',
          }),
    },
  ],
  exposure: { properties: [], type: 'state' },
  state: { state: value },
});

/** Fresh each time: the page writes into what it is given, as it does with the server's. */
const devices = () => [
  lamp(),
  toggle('t1', 'Away', false),
  toggle('t2', 'Guests', true),
  toggle('t4', 'Gasten', 2),
];

const ref = (deviceId: string) => ({ sourceId: 'states', deviceId, propertyKey: 'state' });

async function openStates(over: { devices?: unknown[] } = {}) {
  return openInterface({ state: { devices: over.devices ?? devices() }, at: '/home/states' });
}

const cardOf = (ui: { document: Document }, name: string) =>
  [...ui.document.querySelectorAll('#states .device')].find(
    (card) => card.querySelector('.device-name')?.textContent === name,
  ) as HTMLDetailsElement;

const fieldOf = (card: Element, label: string) =>
  [...card.querySelectorAll('.device-field')]
    .find((field) => field.firstChild?.textContent === label)
    ?.querySelector('input, select') as HTMLInputElement & HTMLSelectElement;

const texts = (select: HTMLSelectElement) => [...select.options].map((option) => option.textContent);

describe('the states, under Home', () => {
  it('are gone from the Devices tab, button and all', async () => {
    const ui = await openInterface({ state: { devices: devices() } });
    const names = [...ui.document.querySelectorAll('#devices .device-name')].map(
      (node) => node.textContent,
    );
    expect(names).toEqual(['Gang Lamp']);
    expect(ui.document.querySelector('#view-devices .tab-buttons button')).toBeNull();
  });

  it('have a page of their own, second in the menu, at /home/states', async () => {
    const ui = await openStates();
    expect(
      [...ui.document.querySelectorAll('.home-menu .home-link')].map((link) => link.textContent),
    ).toEqual(['Rooms', 'States', 'Routes', 'Zigbee map']);
    expect(ui.document.getElementById('home-page-states')?.hidden).toBe(false);
    // By name, and in no room.
    expect(
      [...ui.document.querySelectorAll('#states .device-name')].map((node) => node.textContent),
    ).toEqual(['Away', 'Gasten', 'Guests']);
  });

  it('are drawn as their own kind, saying where they stand, with no label', async () => {
    const ui = await openStates();
    const card = cardOf(ui, 'Away');
    expect(card.querySelector('summary svg.type-icon.state title')?.textContent).toBe('State');
    expect(card.querySelector('.device-seen')?.textContent).toBe('false');
    expect((card.querySelector('summary .badge') as HTMLElement).hidden).toBe(true);
  });

  it('open on a name, a type and a value, and no room', async () => {
    const ui = await openStates();
    const card = cardOf(ui, 'Away');
    await ui.openCard(card);

    expect(fieldOf(card, 'Name').value).toBe('Away');
    expect(fieldOf(card, 'Room')).toBeUndefined();
    expect(texts(fieldOf(card, 'Type'))).toEqual(['Boolean', 'Number']);
    expect(texts(fieldOf(card, 'Value'))).toEqual(['false', 'true']);
    expect(card.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  });

  it('are renamed and flipped on Save, and not before', async () => {
    const ui = await openStates();
    const card = cardOf(ui, 'Away');
    await ui.openCard(card);

    const name = fieldOf(card, 'Name');
    name.value = ' Weg ';
    name.dispatchEvent(new ui.window.Event('input'));
    const value = fieldOf(card, 'Value');
    value.value = 'true';
    value.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();
    expect(card.querySelector('.device-name')?.textContent).toBe('* Away');
    expect(ui.requests.some((request) => request.path.startsWith('/api/states/'))).toBe(false);

    await ui.click(card.querySelector('.rule-footer button.primary'));
    const saved = ui.requests.filter((request) => request.path === '/api/states/t1');
    expect(saved.map((request) => request.body)).toEqual([{ name: 'Weg', value: true }]);
    // Nothing about a room, or anything else kept beside a device.
    expect(ui.requests.some((request) => request.path === '/api/exposure')).toBe(false);
  });

  it('will not save without a name', async () => {
    const ui = await openStates();
    const card = cardOf(ui, 'Away');
    await ui.openCard(card);

    const name = fieldOf(card, 'Name');
    name.value = '  ';
    name.dispatchEvent(new ui.window.Event('input'));
    await ui.click(card.querySelector('.rule-footer button.primary'));

    expect(card.querySelector('.rule-footer .error')?.textContent).toBe('It needs a name');
    expect(ui.requests.some((request) => request.path === '/api/states/t1')).toBe(false);
  });

  it('follow a change made somewhere else', async () => {
    const ui = await openStates();
    const card = cardOf(ui, 'Away');
    await ui.openCard(card);

    await ui.live({ type: 'state', sourceId: 'states', deviceId: 't1', changes: { state: true } });
    expect(card.querySelector('.device-seen')?.textContent).toBe('true');
    expect(fieldOf(card, 'Value').value).toBe('true');
  });

  it('ask twice before one is deleted', async () => {
    const ui = await openStates();
    const card = cardOf(ui, 'Away');
    await ui.openCard(card);

    const remove = card.querySelector('button.danger');
    await ui.click(remove);
    expect(ui.requests.some((request) => request.path === '/api/states/t1')).toBe(false);
    await ui.click(remove);
    expect(ui.requests.some((request) => request.path === '/api/states/t1')).toBe(true);
  });

  it('change type on the card, starting the value again, saved with it', async () => {
    const ui = await openStates();
    const card = cardOf(ui, 'Away');
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

  it('are not a kind a device can be', async () => {
    const ui = await openInterface({ state: { devices: devices() } });
    const card = ui.document.querySelector('#devices .device') as HTMLDetailsElement;
    await ui.openCard(card);
    expect(texts(fieldOf(card, 'Type'))).not.toContain('State');
  });
});

describe('adding a state', () => {
  it('is done on the States page, and opens it to be named', async () => {
    const ui = await openStates();
    ui.responses['POST /api/states'] = { id: 't3' };
    ui.responses['/api/state'] = {
      tileTypes: [],
      devices: [...devices(), toggle('t3', 'New state', false)],
    };

    await ui.click(ui.byText('#home-page-states button', '+ state'));

    expect(ui.requests.some((request) => request.path === '/api/states')).toBe(true);
    const card = cardOf(ui, 'New state');
    expect(card.open).toBe(true);
    expect(ui.document.activeElement).toBe(fieldOf(card, 'Name'));

    // Nothing in it yet, so nothing to ask twice about.
    await ui.click(card.querySelector('button.danger'));
    expect(ui.requests.some((request) => request.path === '/api/states/t3')).toBe(true);
  });
});

describe('a state in a rule', () => {
  const rule = (over: Record<string, unknown> = {}) => ({
    id: 'r1',
    name: 'Weg',
    enabled: true,
    triggers: [{ ...ref('t1'), match: { kind: 'changedTo', value: true } }],
    branches: [{ actions: [{ ...ref('t2'), value: 'toggle' }] }],
    ...over,
  });

  async function openRule(given = rule()) {
    const ui = await openInterface({ state: { devices: devices() }, rules: [given] });
    await ui.click(ui.byText('button.tab', 'Rules'));
    await ui.openCard(ui.document.querySelector('.rule') as HTMLDetailsElement);
    return ui;
  }
  const pickers = (row: Element) => ({
    room: row.querySelector('.room-picker') as HTMLSelectElement,
    device: row.querySelector('.device-picker') as HTMLSelectElement,
  });
  const tail = (row: Element) => [...row.querySelectorAll('.rule-tail select')] as HTMLSelectElement[];

  it('is picked from States, under the rooms and above the clock', async () => {
    const ui = await openRule();
    const { room, device } = pickers(ui.document.querySelector('.triggers .rule-row')!);
    expect(texts(room)).toEqual(['Room', 'Gang', 'States', 'Current time']);
    expect(room.value).toBe('__states');
    expect(texts(device)).toEqual(['Away', 'Gasten', 'Guests']);
  });

  it('is offered under States to an action, above Notification and Ignore', async () => {
    const ui = await openRule();
    const { room } = pickers(ui.document.querySelector('.actions .rule-row')!);
    expect(texts(room).slice(0, 3)).toEqual(['Room', 'Gang', 'States']);
    expect(room.value).toBe('__states');
  });

  it('sets a rule off by a truth becoming one or the other, or changing', async () => {
    const ui = await openRule();
    const [kinds, value] = tail(ui.document.querySelector('.triggers .rule-row')!);
    expect(texts(kinds!)).toEqual(['becomes', 'changes']);
    expect(texts(value!)).toEqual(['true', 'false']);
  });

  it('asks only whether a truth is true or false', async () => {
    const ui = await openRule(
      rule({
        branches: [
          {
            when: { kind: 'test', ...ref('t1'), match: { kind: 'equals', value: true } },
            actions: [{ ...ref('t2'), value: true }],
          },
        ],
      }),
    );
    const [kinds, value] = tail(ui.document.querySelector('.condition-group .rule-row')!);
    expect(texts(kinds!)).toEqual(['is']);
    expect(texts(value!)).toEqual(['true', 'false']);
  });

  it('sets a truth to true or false, or flips it, and nothing else', async () => {
    const ui = await openRule();
    const [mode, value] = tail(ui.document.querySelector('.actions .rule-row')!);
    expect(texts(mode!)).toEqual(['set to']);
    expect(texts(value!).map((text) => text?.trim())).toEqual(['true', 'false', 'toggle']);
    expect(value!.value).toBe('toggle');
  });

  it('keeps showing what a rule asked before it stopped being offered', async () => {
    const ui = await openRule(
      rule({
        branches: [
          {
            when: { kind: 'test', ...ref('t1'), match: { kind: 'changed' } },
            actions: [{ ...ref('t2'), valueFrom: { kind: 'trigger' } }],
          },
        ],
      }),
    );
    const [asked] = tail(ui.document.querySelector('.condition-group .rule-row')!);
    expect(asked!.value).toBe('changed');
    const [mode] = tail(ui.document.querySelector('.actions .rule-row')!);
    expect(texts(mode!)).toEqual(['set to', 'match the trigger']);
    expect(mode!.value).toBe('trigger');
  });

  it('treats a number the way any other number is treated', async () => {
    const ui = await openRule(
      rule({
        triggers: [{ ...ref('t4'), match: { kind: 'above', value: 2 } }],
        branches: [{ actions: [{ ...ref('t4'), value: 3 }] }],
      }),
    );
    const [kinds] = tail(ui.document.querySelector('.triggers .rule-row')!);
    expect(texts(kinds!)).toEqual(['becomes', 'is', 'is not', 'changes', 'rises above', 'falls below']);
    const [mode] = tail(ui.document.querySelector('.actions .rule-row')!);
    expect(texts(mode!)).toEqual(['set to', 'match the trigger', 'increase by', 'decrease by']);
  });
});

describe('a state elsewhere', () => {
  it('can be a member of a mirror when it is a truth', async () => {
    const ui = await openInterface({
      state: { devices: devices() },
      rules: [{ id: 'm1', kind: 'mirror', name: 'Samen', enabled: true, groups: [] }],
    });
    await ui.click(ui.byText('button.tab', 'Mirrors'));
    await ui.openCard(ui.document.querySelector('#mirror .rule') as HTMLDetailsElement);
    const offered = [...ui.document.querySelectorAll('#mirror .mirror-devices label')].map(
      (label) => label.textContent,
    );
    expect(offered).toContain('Away');
    expect(offered).not.toContain('Gasten');
  });

  it('reads in the log as a state, where it stands and who did it', async () => {
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
    const ui = await openInterface({ state: { devices: devices() }, log });
    await ui.click(ui.byText('button.tab', 'Log'));

    const line = ui.document.querySelector('#activity-log .log-line')!;
    expect(line.querySelector('.tag')?.textContent).toBe('state');
    const what = line.querySelector('.log-what')!;
    expect(what.querySelector('svg.type-icon.state')).not.toBeNull();
    what.querySelectorAll('title').forEach((title) => title.remove());
    expect(what.textContent).toBe('Away: true (by hand)');

    const box = ui.document.getElementById('kind-state') as HTMLInputElement;
    expect(box.parentElement?.textContent?.trim()).toBe('State');
    expect(box.checked).toBe(true);
  });
});
