import { describe, expect, it } from 'vitest';

import { openInterface } from './helpers/interface.js';

const device = (deviceId: string, name: string, model: string) => ({
  sourceId: 'zigbee',
  deviceId,
  name,
  topic: `zigbee2mqtt/${name}`,
  manufacturer: 'SONOFF',
  model,
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
      toggleValue: 'TOGGLE',
    },
  ],
  exposure: { properties: [] },
  state: {},
  lastSeen: {},
});

const devices = [
  device('0xa', 'hall_lamp', 'ZBMINIL2'),
  device('0xb', 'porch_lamp', 'ZBMINIL2'),
  device('0xc', 'shed_lamp', 'S31ZB'),
];

const ref = (deviceId: string) => ({ sourceId: 'zigbee', deviceId, propertyKey: 'state' });

/** A rule in the shape saved since outcomes: triggers, and actions per branch. */
const automation = (
  id: string,
  name: string,
  from: string,
  to: string,
  extra?: Record<string, unknown>,
) => ({
  id,
  name,
  enabled: true,
  triggers: [{ ...ref(from), match: { kind: 'changedTo', value: 'ON' } }],
  branches: [{ actions: [{ ...ref(to), value: 'ON' }] }],
  ...extra,
});

const mirror = (id: string, name: string, a: string, b: string) => ({
  id,
  kind: 'mirror',
  name,
  enabled: true,
  groups: [[ref(a), ref(b)]],
});

async function openTab(tab: string, rules: unknown[]) {
  const ui = await openInterface({ state: { devices }, rules });
  await ui.click(ui.byText('button.tab', tab));
  return ui;
}

function named(ui: { document: Document }, container: string): (string | null)[] {
  return [...ui.document.querySelectorAll(`${container} .device-name`)].map(
    (node) => node.textContent,
  );
}

async function filterFor(
  ui: Awaited<ReturnType<typeof openTab>>,
  term: string,
): Promise<void> {
  const filter = ui.document.querySelector('#filter') as HTMLInputElement;
  filter.value = term;
  filter.dispatchEvent(new ui.window.Event('input'));
  await ui.settle();
}

async function sortBy(
  ui: Awaited<ReturnType<typeof openTab>>,
  value: string,
): Promise<void> {
  const sort = ui.document.querySelector('#sort') as HTMLSelectElement;
  sort.value = value;
  sort.dispatchEvent(new ui.window.Event('change'));
  await ui.settle();
}

describe('filtering the automation list', () => {
  const rules = [
    automation('r1', 'Zebra', '0xa', '0xb'),
    automation('r2', 'Apple', '0xb', '0xc'),
  ];

  it('matches on the name of the rule', async () => {
    const ui = await openTab('Automation', rules);
    await filterFor(ui, 'zebra');
    expect(named(ui, '#automation')).toEqual(['Zebra']);
  });

  it('matches on a device the rule acts on', async () => {
    const ui = await openTab('Automation', rules);
    // Walking the devices is where reading the wrong shape used to throw,
    // and a throw here emptied the tab rather than showing anything.
    await filterFor(ui, 'shed_lamp');
    expect(named(ui, '#automation')).toEqual(['Apple']);
  });

  it('matches on the model of a device it acts on', async () => {
    const ui = await openTab('Automation', rules);
    await filterFor(ui, 's31zb');
    expect(named(ui, '#automation')).toEqual(['Apple']);
  });

  it('looks in every outcome, not only the first', async () => {
    const late = automation('r3', 'Later', '0xa', '0xa', {
      branches: [
        { actions: [{ ...ref('0xa'), value: 'ON' }] },
        { actions: [{ ...ref('0xc'), value: 'ON' }] },
      ],
    });
    const ui = await openTab('Automation', [late]);
    await filterFor(ui, 'shed_lamp');
    expect(named(ui, '#automation')).toEqual(['Later']);
  });

  it('still reads a rule saved before outcomes existed', async () => {
    const old = {
      id: 'r9',
      name: 'Old shape',
      enabled: true,
      trigger: { ...ref('0xa'), match: { kind: 'changedTo', value: 'ON' } },
      actions: [{ ...ref('0xc'), value: 'ON' }],
    };
    const ui = await openTab('Automation', [old]);
    await filterFor(ui, 'shed_lamp');
    expect(named(ui, '#automation')).toEqual(['Old shape']);
  });

  it('says so when nothing matches, rather than showing an empty tab', async () => {
    const ui = await openTab('Automation', rules);
    await filterFor(ui, 'nothing called this');
    expect(ui.document.querySelector('#automation')!.textContent).toContain('Nothing matches');
  });
});

describe('sorting the automation list', () => {
  const rules = [
    automation('r1', 'Zebra', '0xa', '0xc'),
    automation('r2', 'Apple', '0xb', '0xb'),
  ];

  it('sorts by name', async () => {
    const ui = await openTab('Automation', rules);
    expect(named(ui, '#automation')).toEqual(['Apple', 'Zebra']);
  });

  it('offers name and trigger, and nothing about the target', async () => {
    const ui = await openTab('Automation', rules);
    const options = [...ui.document.querySelectorAll('#sort option')].map(
      (node) => (node as HTMLOptionElement).value,
    );
    expect(options).toEqual(['name', 'room', 'trigger']);
  });
});

describe('listing automations under their trigger', () => {
  const headings = (ui: { document: Document }) =>
    [...ui.document.querySelectorAll('#automation .rule-group')].map((node) => node.textContent);

  /** Two buttons on one remote, and a third on another. */
  const shelly = automation('r1', 'Hall on', '0xa', '0xb', {
    triggers: [{ ...ref('0xa'), match: { kind: 'changedTo', value: '1_single' } }],
  });
  const shellyToo = automation('r2', 'Porch on', '0xa', '0xc', {
    triggers: [{ ...ref('0xa'), match: { kind: 'changedTo', value: '2_double' } }],
  });
  const aqara = automation('r3', 'Shed on', '0xb', '0xc', {
    triggers: [{ ...ref('0xb'), match: { kind: 'changedTo', value: 'single_left' } }],
  });

  it('puts a heading per trigger device, in name order', async () => {
    const ui = await openTab('Automation', [aqara, shelly, shellyToo]);
    await sortBy(ui, 'trigger');
    expect(headings(ui)).toEqual(['hall_lamp', 'porch_lamp']);
  });

  it('names the automation, then what sets it off', async () => {
    const ui = await openTab('Automation', [shelly, shellyToo]);
    await sortBy(ui, 'trigger');

    // The heading has said which device, so the line is about the automation.
    expect(named(ui, '#automation')).toEqual(['Hall on', 'Porch on']);
    const meta = [...ui.document.querySelectorAll('#automation .device-meta')].map(
      (node) => node.textContent,
    );
    expect(meta).toEqual(['State becomes 1_single', 'State becomes 2_double']);
  });

  it('lists a rule once per trigger, under each device', async () => {
    const both = automation('r4', 'Either', '0xa', '0xc', {
      triggers: [
        { ...ref('0xa'), match: { kind: 'changedTo', value: 'ON' } },
        { ...ref('0xb'), match: { kind: 'changedTo', value: 'ON' } },
      ],
    });
    const ui = await openTab('Automation', [both]);
    await sortBy(ui, 'trigger');

    // The list answers what a button does, so one rule can answer twice.
    expect(headings(ui)).toEqual(['hall_lamp', 'porch_lamp']);
    expect(ui.document.querySelectorAll('#automation .rule')).toHaveLength(2);
  });

  it('opens one occurrence without opening the other', async () => {
    const both = automation('r4', 'Either', '0xa', '0xc', {
      triggers: [
        { ...ref('0xa'), match: { kind: 'changedTo', value: 'ON' } },
        { ...ref('0xb'), match: { kind: 'changedTo', value: 'ON' } },
      ],
    });
    const ui = await openTab('Automation', [both]);
    await sortBy(ui, 'trigger');

    const cards = [...ui.document.querySelectorAll('#automation .rule')] as HTMLDetailsElement[];
    await ui.openCard(cards[0]!);

    const after = [...ui.document.querySelectorAll('#automation .rule')] as HTMLDetailsElement[];
    // Two editors of one rule means two drafts, and the second save wins.
    expect(after.map((card) => card.open)).toEqual([true, false]);
  });

  it('groups anything whose trigger device has gone at the end', async () => {
    const orphan = automation('r5', 'Gone', '0xz', '0xc', {
      triggers: [{ ...ref('0xz'), match: { kind: 'changedTo', value: 'ON' } }],
    });
    const ui = await openTab('Automation', [orphan, shelly]);
    await sortBy(ui, 'trigger');
    expect(headings(ui)).toEqual(['hall_lamp', 'No device']);
  });
});

describe('naming a rule by where it acts', () => {
  const placed = (room?: string, deviceId = '0xb') =>
    devices.map((entry) =>
      entry.deviceId === deviceId
        ? { ...entry, exposure: { properties: [], ...(room ? { room } : {}) } }
        : { ...entry, exposure: { properties: [] } },
    );

  const titles = (ui: { document: Document }) =>
    [...ui.document.querySelectorAll('#automation .device-name')].map((node) => node.textContent);

  it('says the room the rule acts in, not the one it is set off from', async () => {
    // The trigger is on 0xa, the action on 0xb.
    const ui = await openInterface({
      state: { devices: placed('Study') },
      rules: [automation('r1', 'Nightlight toggle', '0xa', '0xb')],
    });
    await ui.click(ui.byText('button.tab', 'Automation'));
    expect(titles(ui)).toEqual(['Study: Nightlight toggle']);
  });

  it('lists every room it reaches', async () => {
    const two = automation('r1', 'Evening', '0xa', '0xb', {
      branches: [
        {
          actions: [
            { sourceId: 'zigbee', deviceId: '0xb', propertyKey: 'state', value: 'ON' },
            { sourceId: 'zigbee', deviceId: '0xc', propertyKey: 'state', value: 'ON' },
          ],
        },
      ],
    });
    const spread = devices.map((entry) => ({
      ...entry,
      exposure: {
        properties: [],
        ...(entry.deviceId === '0xb' ? { room: 'Study' } : {}),
        ...(entry.deviceId === '0xc' ? { room: 'Kitchen' } : {}),
      },
    }));

    const ui = await openInterface({ state: { devices: spread }, rules: [two] });
    await ui.click(ui.byText('button.tab', 'Automation'));
    expect(titles(ui)).toEqual(['Kitchen / Study: Evening']);
  });

  it('says nothing extra when no device it touches has a room', async () => {
    const ui = await openInterface({
      state: { devices: placed(undefined) },
      rules: [automation('r1', 'Nightlight toggle', '0xa', '0xb')],
    });
    await ui.click(ui.byText('button.tab', 'Automation'));
    expect(titles(ui)).toEqual(['Nightlight toggle']);
  });

  it('keeps the room when the heading is a device rather than a room', async () => {
    const placed = devices.map((entry) => ({
      ...entry,
      exposure: { properties: [], ...(entry.deviceId === '0xb' ? { room: 'Study' } : {}) },
    }));
    const ui = await openInterface({
      state: { devices: placed },
      rules: [automation('r1', 'Nightlight toggle', '0xa', '0xb')],
    });
    await ui.click(ui.byText('button.tab', 'Automation'));
    await sortBy(ui, 'trigger');

    // The heading names the remote, which says nothing about where it acts.
    expect(titles(ui)).toEqual(['Study: Nightlight toggle']);
  });

  it('drops the room once the list is grouped by it', async () => {
    const ui = await openInterface({
      state: { devices: placed('Study') },
      rules: [automation('r1', 'Nightlight toggle', '0xa', '0xb')],
    });
    await ui.click(ui.byText('button.tab', 'Automation'));
    await sortBy(ui, 'room');

    // The heading has said it already.
    expect(titles(ui)).toEqual(['Nightlight toggle']);
  });

  it('lists a rule under every room it reaches', async () => {
    const two = automation('r1', 'Evening', '0xa', '0xb', {
      branches: [
        {
          actions: [
            { sourceId: 'zigbee', deviceId: '0xb', propertyKey: 'state', value: 'ON' },
            { sourceId: 'zigbee', deviceId: '0xc', propertyKey: 'state', value: 'ON' },
          ],
        },
      ],
    });
    const spread = devices.map((entry) => ({
      ...entry,
      exposure: {
        properties: [],
        ...(entry.deviceId === '0xb' ? { room: 'Study' } : {}),
        ...(entry.deviceId === '0xc' ? { room: 'Kitchen' } : {}),
      },
    }));

    const ui = await openInterface({ state: { devices: spread }, rules: [two] });
    await ui.click(ui.byText('button.tab', 'Automation'));
    await sortBy(ui, 'room');

    const headings = [...ui.document.querySelectorAll('#automation .rule-group')].map(
      (node) => node.textContent,
    );
    // It is the answer in both rooms, so it is listed in both.
    expect(headings).toEqual(['Kitchen', 'Study']);
    expect(ui.document.querySelectorAll('#automation .rule')).toHaveLength(2);

    // And it still says both under either, since the other room is news.
    const titles = [...ui.document.querySelectorAll('#automation .device-name')].map(
      (node) => node.textContent,
    );
    expect(titles).toEqual(['Kitchen / Study: Evening', 'Kitchen / Study: Evening']);
  });
});

describe('keeping a description on one line', () => {
  it('wraps each device and its count in one piece', async () => {
    const ui = await openTab('Automation', [automation('r1', 'Hall on', '0xa', '0xb')]);
    const chunks = [...ui.document.querySelectorAll('#automation .device-meta .chunk')].map(
      (node) => node.textContent,
    );

    // An icon must not end a line with its device name on the next.
    expect(chunks).toEqual(['hall_lamp', 'porch_lamp']);
  });

  it('keeps a timer wait whole', async () => {
    const timer = {
      id: 't1',
      kind: 'timer',
      name: 'Light out',
      enabled: true,
      triggers: [{ ...ref('0xa'), match: { kind: 'changedTo', value: 'ON' } }],
      waitMs: 90_000,
      actions: [{ ...ref('0xb'), value: 'OFF' }],
    };
    const ui = await openInterface({ state: { devices }, rules: [timer] });
    await ui.click(ui.byText('button.tab', 'Timers'));

    const chunks = [...ui.document.querySelectorAll('#timers .device-meta .chunk')].map(
      (node) => node.textContent,
    );
    // The time is one piece. The arrows either side may end a line.
    expect(chunks).toContain('01:30');
  });
});

describe('what the line under a rule says', () => {
  const meta = (ui: { document: Document }) =>
    ui.document.querySelector('#automation .device-meta')?.textContent;

  it('names the devices and nothing about their functions', async () => {
    const ui = await openTab('Automation', [automation('r1', 'Hall on', '0xa', '0xb')]);
    // Which function it writes is in the rule. Saying "state" here said
    // nothing anybody was reading for.
    expect(meta(ui)).toBe('hall_lamp → porch_lamp');
  });

  it('counts the rest rather than listing them', async () => {
    const many = automation('r1', 'Evening', '0xa', '0xb', {
      triggers: [
        { sourceId: 'zigbee', deviceId: '0xa', propertyKey: 'state', match: { kind: 'changedTo', value: 'ON' } },
        { sourceId: 'zigbee', deviceId: '0xc', propertyKey: 'state', match: { kind: 'changedTo', value: 'ON' } },
      ],
      branches: [
        {
          actions: [
            { sourceId: 'zigbee', deviceId: '0xb', propertyKey: 'state', value: 'ON' },
            { sourceId: 'zigbee', deviceId: '0xc', propertyKey: 'state', value: 'ON' },
          ],
        },
        { actions: [{ sourceId: 'zigbee', deviceId: '0xb', propertyKey: 'state', value: 'OFF' }] },
      ],
    });
    const ui = await openTab('Automation', [many]);
    expect(meta(ui)).toBe('hall_lamp (+1) → porch_lamp (+1) - 2 outcomes');
  });

  it('says nothing about outcomes when there is only one', async () => {
    const ui = await openTab('Automation', [automation('r1', 'Hall on', '0xa', '0xb')]);
    expect(meta(ui)).not.toContain('outcome');
  });

  it('keeps the room on a device from somewhere else', async () => {
    // A remote in the living room switching a kitchen light is listed under
    // Kitchen, and which remote it is still matters.
    const placed = devices.map((entry) => ({
      ...entry,
      exposure: {
        properties: [],
        ...(entry.deviceId === '0xa' ? { room: 'Living room', label: 'Remote' } : {}),
        ...(entry.deviceId === '0xb' ? { room: 'Kitchen', label: 'Light' } : {}),
      },
    }));
    const ui = await openInterface({
      state: { devices: placed },
      rules: [automation('r1', 'Kitchen light', '0xa', '0xb')],
    });
    await ui.click(ui.byText('button.tab', 'Automation'));
    await sortBy(ui, 'room');

    expect(meta(ui)).toBe('Living room Remote → Light');
  });

  it('drops the room from the names once the list is grouped by room', async () => {
    const placed = devices.map((entry) => ({
      ...entry,
      exposure: { properties: [], ...(entry.deviceId === '0xb' ? { room: 'Study', label: 'Lamp' } : {}) },
    }));
    const ui = await openInterface({
      state: { devices: placed },
      rules: [automation('r1', 'Nightlight', '0xa', '0xb')],
    });
    await ui.click(ui.byText('button.tab', 'Automation'));

    expect(meta(ui)).toContain('Study Lamp');
    await sortBy(ui, 'room');
    // The heading says Study, so the name need not say it twice.
    expect(meta(ui)).toContain('Lamp');
    expect(meta(ui)).not.toContain('Study Lamp');
  });
});

describe('a rule just added', () => {
  it('sits at the top until it is saved, whatever it is called', async () => {
    const apple = automation('r1', 'Apple', '0xa', '0xb');
    const ui = await openTab('Automation', [apple]);

    const added = automation('r2', 'New automation', '0xa', '0xb');
    ui.responses['PUT /api/rules'] = { rule: { id: 'r2' } };
    ui.responses['/api/rules'] = { rules: [apple, added] };

    await ui.click(ui.byText('button', '+ automation'));

    // By name it would be second and easy to miss on a long list.
    expect(named(ui, '#automation')).toEqual(['New automation', 'Apple']);
  });

  it('shows through a filter that would otherwise hide it', async () => {
    const apple = automation('r1', 'Apple', '0xa', '0xb');
    const ui = await openTab('Automation', [apple]);
    await filterFor(ui, 'apple');
    expect(named(ui, '#automation')).toEqual(['Apple']);

    const added = automation('r2', 'New automation', '0xa', '0xb');
    ui.responses['PUT /api/rules'] = { rule: { id: 'r2' } };
    ui.responses['/api/rules'] = { rules: [apple, added] };
    await ui.click(ui.byText('button', '+ automation'));

    // Adding something that then vanishes is worse than a filter being ignored.
    expect(named(ui, '#automation')).toEqual(['New automation', 'Apple']);
  });

  it('takes its place in the order once saved', async () => {
    const apple = automation('r1', 'Apple', '0xa', '0xb');
    const ui = await openTab('Automation', [apple]);

    const added = automation('r2', 'New automation', '0xa', '0xb');
    ui.responses['PUT /api/rules'] = { rule: { id: 'r2' } };
    ui.responses['/api/rules'] = { rules: [apple, added] };
    await ui.click(ui.byText('button', '+ automation'));

    const card = ui.document.querySelector('#automation .rule') as HTMLDetailsElement;
    await ui.click(ui.byText('button.primary', 'Save', '#automation'));

    expect(card).not.toBeNull();
    expect(named(ui, '#automation')).toEqual(['Apple', 'New automation']);
  });
});

describe('switching a rule on and off', () => {
  const apple = automation('r1', 'Apple', '0xa', '0xb');

  it('sits in the header and says which it is', async () => {
    const ui = await openTab('Automation', [{ ...apple, enabled: false }]);
    const toggle = ui.document.querySelector('#automation .rule-enabled') as HTMLElement;

    expect(toggle.textContent).toContain('disabled');
    expect((toggle.querySelector('input') as HTMLInputElement).checked).toBe(false);
  });

  it('saves as it is clicked, without touching the panel', async () => {
    const ui = await openTab('Automation', [apple]);
    const box = ui.document.querySelector('#automation .rule-enabled input') as HTMLInputElement;

    box.checked = false;
    box.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();

    const saved = ui.requests.findLast((request) => request.body !== undefined)?.body as {
      id: string;
      enabled: boolean;
    };
    // The stored rule with one thing changed, not whatever is on the screen.
    expect(saved).toMatchObject({ id: 'r1', enabled: false });
  });

  it('changes its word when it is switched', async () => {
    const ui = await openTab('Automation', [apple]);
    const box = ui.document.querySelector('#automation .rule-enabled input') as HTMLInputElement;
    expect(
      (ui.document.querySelector('#automation .rule-enabled') as HTMLElement).textContent,
    ).toContain('enabled');

    // What the server holds after the change, since the list is reloaded.
    ui.responses['/api/rules'] = { rules: [{ ...apple, enabled: false }] };
    box.checked = false;
    box.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();

    const toggle = ui.document.querySelector('#automation .rule-enabled') as HTMLElement;
    expect(toggle.textContent).toContain('disabled');
    expect((toggle.querySelector('input') as HTMLInputElement).checked).toBe(false);
  });

  it('puts the word back if the save is refused', async () => {
    const ui = await openTab('Automation', [apple]);
    const box = ui.document.querySelector('#automation .rule-enabled input') as HTMLInputElement;

    ui.failures['PUT /api/rules'] = { status: 500, body: { error: 'no' } };
    box.checked = false;
    box.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();

    // Saying it is off when it is not would be worse than saying nothing.
    expect(
      (ui.document.querySelector('#automation .rule-enabled') as HTMLElement).textContent,
    ).toContain('enabled');
  });

  it('does not open the panel when clicked', async () => {
    const ui = await openTab('Automation', [apple]);
    const card = ui.document.querySelector('#automation .rule') as HTMLDetailsElement;
    const toggle = ui.document.querySelector('#automation .rule-enabled') as HTMLElement;

    toggle.dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
    await ui.settle();

    expect(card.open).toBe(false);
  });
});

describe('running a rule by hand', () => {
  const apple = automation('r1', 'Apple', '0xa', '0xb');

  async function openSaved(rules: unknown[] = [apple]) {
    const ui = await openTab('Automation', rules);
    const card = ui.document.querySelector('#automation .rule') as HTMLDetailsElement;
    await ui.openCard(card);
    return ui;
  }

  const trigger = (ui: { document: Document }) =>
    [...ui.document.querySelectorAll('#automation .rule-footer button')].find(
      (node) => node.textContent === 'Trigger',
    ) as HTMLButtonElement;

  it('sits beside Save and asks the server to run it', async () => {
    const ui = await openSaved();
    expect(trigger(ui).hidden).toBe(false);

    await ui.click(trigger(ui));
    expect(ui.requests.some((request) => request.path === '/api/rules/r1/run')).toBe(true);
  });

  it('goes away once the rule has been edited', async () => {
    const ui = await openSaved();
    const name = ui.document.querySelector('#automation .device-body input') as HTMLInputElement;

    name.value = 'Something else';
    // Typing bubbles, which is how the panel notices at all.
    name.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    await ui.settle();

    // The engine reads what is stored, so running now would run something
    // other than what is on the screen. A button that has gone is
    // unmistakable, where a greyed one is a shade nobody notices.
    expect(trigger(ui).hidden).toBe(true);
  });

  it('is absent on a rule that has only just been added', async () => {
    const added = automation('r2', 'New automation', '0xa', '0xb');
    const ui = await openTab('Automation', [apple]);
    ui.responses['PUT /api/rules'] = { rule: { id: 'r2' } };
    ui.responses['/api/rules'] = { rules: [apple, added] };
    await ui.click(ui.byText('button', '+ automation'));

    const card = ui.document.querySelector('#automation .rule') as HTMLDetailsElement;
    await ui.openCard(card);

    expect(trigger(ui).hidden).toBe(true);
  });

  it('is not offered on a mirror rule', async () => {
    const ui = await openInterface({
      state: { devices },
      rules: [
        {
          id: 'm1',
          kind: 'mirror',
          name: 'Together',
          enabled: true,
          groups: [[ref('0xa'), ref('0xb')]],
        },
      ],
    });
    await ui.click(ui.byText('button.tab', 'Mirror devices'));
    const card = ui.document.querySelector('#mirror .rule') as HTMLDetailsElement;
    await ui.openCard(card);

    // Every member of a mirror is a trigger, so there is nothing to press.
    const buttons = [...ui.document.querySelectorAll('#mirror .rule-footer button')].map(
      (node) => node.textContent,
    );
    expect(buttons).not.toContain('Trigger');
  });
});

describe('deleting a rule', () => {
  const apple = automation('r1', 'Apple', '0xa', '0xb');

  async function openSaved() {
    const ui = await openTab('Automation', [apple]);
    const card = ui.document.querySelector('#automation .rule') as HTMLDetailsElement;
    await ui.openCard(card);
    return ui;
  }

  const deleteButton = (ui: { document: Document }) =>
    ui.document.querySelector('#automation .rule-footer button.danger') as HTMLButtonElement;

  it('asks once before deleting something that was saved', async () => {
    const ui = await openSaved();
    const button = deleteButton(ui);
    expect(button.textContent).toBe('Delete');

    await ui.click(button);
    expect(button.textContent).toBe('Confirm');
    // Nothing has gone yet.
    expect(ui.requests.some((request) => request.path.includes('/api/rules/r1'))).toBe(false);

    await ui.click(button);
    expect(ui.requests.some((request) => request.path.includes('/api/rules/r1'))).toBe(true);
  });

  it('goes back to asking after a couple of seconds', async () => {
    const ui = await openSaved();
    const button = deleteButton(ui);
    button.click();
    expect(button.textContent).toBe('Confirm');

    // A real wait: the countdown runs on the page's own timers, which fake
    // ones do not reach from out here.
    await new Promise((resolve) => setTimeout(resolve, 2300));

    // A button left saying Confirm would be a trap for the next click.
    expect(button.textContent).toBe('Delete');
    expect(button.classList.contains('armed')).toBe(false);
  }, 6000);

  it('deletes a rule just added on the first click', async () => {
    const ui = await openTab('Automation', [apple]);
    ui.responses['PUT /api/rules'] = { rule: { id: 'r2' } };
    ui.responses['/api/rules'] = { rules: [apple, automation('r2', 'New automation', '0xa', '0xb')] };
    await ui.click(ui.byText('button', '+ automation'));

    // Nothing has been written into it yet, so asking twice is in the way.
    const button = ui.document.querySelector(
      '#automation .rule-footer button.danger',
    ) as HTMLButtonElement;
    await ui.click(button);
    expect(ui.requests.some((request) => request.path.includes('/api/rules/r2'))).toBe(true);
  });

  it('sits at the far end of the footer, away from Save', async () => {
    const ui = await openSaved();
    const footer = ui.document.querySelector('#automation .rule-footer')!;
    expect(footer.lastElementChild).toBe(deleteButton(ui));
  });
});

describe('grouping automations by the device they act on', () => {
  const lamp = automation('r1', 'Kitchen light', '0xa', '0xb');
  const shed = automation('r2', 'Shed light', '0xa', '0xc');

  it('groups by room, with the unset ones last', async () => {
    const ui = await openInterface({
      state: {
        devices: [
          { ...devices[0]!, exposure: { properties: [] } },
          { ...devices[1]!, exposure: { properties: [], room: 'Kitchen' } },
          { ...devices[2]!, exposure: { properties: [] } },
        ],
      },
      rules: [lamp, shed],
    });
    await ui.click(ui.byText('button.tab', 'Automation'));
    await sortBy(ui, 'room');

    const headings = [...ui.document.querySelectorAll('#automation .rule-group')].map(
      (node) => node.textContent,
    );
    expect(headings).toEqual(['Kitchen', 'Unknown']);
  });

});

describe('the mirror list', () => {
  const rules = [mirror('m1', 'Zebra', '0xa', '0xc'), mirror('m2', 'Apple', '0xb', '0xb')];

  it('filters by a device in the group', async () => {
    const ui = await openTab('Mirror devices', rules);
    await filterFor(ui, 'shed_lamp');
    expect(named(ui, '#mirror')).toEqual(['Zebra']);
  });

  it('offers name and room only, since its two sides are the same thing', async () => {
    const ui = await openTab('Mirror devices', rules);
    const options = [...ui.document.querySelectorAll('#sort option')].map(
      (node) => (node as HTMLOptionElement).value,
    );
    expect(options).toEqual(['name', 'room']);
  });
});

describe('a rule this build cannot read', () => {
  it('costs its own list and no more', async () => {
    const broken = { id: 'bad', name: 'Broken', enabled: true, branches: 'not a list' };
    const ui = await openTab('Mirror devices', [broken, mirror('m1', 'Fine', '0xa', '0xb')]);
    await filterFor(ui, 'lamp');

    // The mirror list is unaffected by the automation list falling over...
    expect(named(ui, '#mirror')).toEqual(['Fine']);
    // ...and the failure is said out loud rather than looking like no rules.
    expect(ui.document.querySelector('#status')!.textContent).toContain('display error');
  });
});
