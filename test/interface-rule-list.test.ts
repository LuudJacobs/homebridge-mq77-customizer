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
    expect(options).toEqual(['name', 'trigger']);
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
    cards[0]!.open = true;
    cards[0]!.dispatchEvent(new ui.window.Event('toggle'));
    await ui.settle();

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

describe('a rule just added', () => {
  it('sits at the top until it is saved, whatever it is called', async () => {
    const apple = automation('r1', 'Apple', '0xa', '0xb');
    const ui = await openTab('Automation', [apple]);

    const added = automation('r2', 'New automation', '0xa', '0xb');
    ui.responses['PUT /api/rules'] = { rule: { id: 'r2' } };
    ui.responses['/api/rules'] = { rules: [apple, added] };

    await ui.click(ui.byText('button', 'Add automation'));

    // By name it would be second and easy to miss on a long list.
    expect(named(ui, '#automation')).toEqual(['New automation', 'Apple']);
  });

  it('takes its place in the order once saved', async () => {
    const apple = automation('r1', 'Apple', '0xa', '0xb');
    const ui = await openTab('Automation', [apple]);

    const added = automation('r2', 'New automation', '0xa', '0xb');
    ui.responses['PUT /api/rules'] = { rule: { id: 'r2' } };
    ui.responses['/api/rules'] = { rules: [apple, added] };
    await ui.click(ui.byText('button', 'Add automation'));

    const card = ui.document.querySelector('#automation .rule') as HTMLDetailsElement;
    await ui.click(ui.byText('button.primary', 'Save', '#automation'));

    expect(card).not.toBeNull();
    expect(named(ui, '#automation')).toEqual(['Apple', 'New automation']);
  });
});

describe('the mirror list', () => {
  const rules = [mirror('m1', 'Zebra', '0xa', '0xc'), mirror('m2', 'Apple', '0xb', '0xb')];

  it('filters by a device in the group', async () => {
    const ui = await openTab('Mirror devices', rules);
    await filterFor(ui, 'shed_lamp');
    expect(named(ui, '#mirror')).toEqual(['Zebra']);
  });

  it('sorts by the first device of the group', async () => {
    const ui = await openTab('Mirror devices', rules);
    await sortBy(ui, 'trigger');
    expect(named(ui, '#mirror')).toEqual(['Zebra', 'Apple']);
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
