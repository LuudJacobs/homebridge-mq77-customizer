import { describe, expect, it } from 'vitest';

import { openInterface } from './helpers/interface.js';

const device = (deviceId: string, name: string) => ({
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
      toggleValue: 'TOGGLE',
    },
  ],
  exposure: { properties: [] },
  state: {},
  lastSeen: {},
});

const devices = [device('0xa', 'lamp_a'), device('0xb', 'lamp_b'), device('0xc', 'lamp_c')];

const ref = (deviceId: string) => ({ sourceId: 'zigbee', deviceId, propertyKey: 'state' });
const test_ = (deviceId: string) => ({ kind: 'test', ...ref(deviceId), match: { kind: 'equals', value: 'ON' } });

/** A rule as an older version stored it: a flat list meaning all of them. */
const legacyRule = {
  id: 'r1',
  name: 'Old rule',
  enabled: true,
  trigger: { ...ref('0xa'), match: { kind: 'changedTo', value: 'ON' } },
  conditions: [{ ...ref('0xb'), match: { kind: 'equals', value: 'ON' } }],
  actions: [{ ...ref('0xc'), value: 'ON' }],
};

async function openRule(rule: unknown) {
  const ui = await openInterface({ state: { devices }, rules: [rule] });
  await ui.click(ui.byText('button.tab', 'Automation'));
  const card = ui.document.querySelector('.rule') as HTMLDetailsElement;
  await ui.openCard(card);
  return ui;
}

describe('the condition editor', () => {
  it('shows the conditions of a rule saved before expressions existed', async () => {
    const ui = await openRule(legacyRule);

    // Reading only the new field would show this rule as having no conditions
    // and then drop them on save.
    expect(ui.document.querySelectorAll('.condition-group')).toHaveLength(1);
    expect(ui.document.querySelectorAll('.condition-group .rule-row')).toHaveLength(1);
  });

  it('offers a second group once there is one, and joins them with or', async () => {
    const ui = await openRule(legacyRule);
    expect(ui.byText('button.add-row', 'Add or', '.conditions')).not.toBeNull();

    await ui.click(ui.byText('button.add-row', 'Add or', '.conditions'));

    expect(ui.document.querySelectorAll('.condition-group')).toHaveLength(2);
    expect(ui.byText('p.joiner', 'or')).not.toBeNull();
  });

  it('adds a test inside a group, joined with and', async () => {
    const ui = await openRule(legacyRule);
    await ui.click(ui.byText('button.add-row', '+ condition', '.conditions'));

    expect(ui.document.querySelectorAll('.condition-group .rule-row')).toHaveLength(2);
    expect(ui.byText('span.joiner', 'and')).not.toBeNull();
  });

  it('keeps the and and the add button on the row rather than under it', async () => {
    const ui = await openRule(legacyRule);
    await ui.click(ui.byText('button.add-row', '+ condition', '.conditions'));

    const rows = [...ui.document.querySelectorAll('.condition-group .rule-row')];
    // The word joining two tests belongs to the row it follows...
    const first = rows[0]!.querySelector('.rule-tail')!;
    expect(first.lastElementChild?.textContent).toBe('and');
    // ...and the button that adds another sits at the end of the last row.
    const last = rows[1]!.querySelector('.rule-tail')!;
    expect(last.lastElementChild?.textContent).toBe('+ condition');
  });

  it('starts a rule with no conditions at one button, and builds from it', async () => {
    const ui = await openRule({ ...legacyRule, conditions: [] });
    expect(ui.document.querySelectorAll('.condition-group')).toHaveLength(0);

    // With no rows yet the button has nowhere to sit but beside the heading.
    expect(ui.byText('button.add-row', '+ condition', '.branch-head')).not.toBeNull();

    await ui.click(ui.byText('button.add-row', '+ condition', '.branch-head'));
    expect(ui.document.querySelectorAll('.condition-group')).toHaveLength(1);
    // Once there is a row to hang it off, it is no longer up in the heading.
    expect(ui.byText('button.add-row', '+ condition', '.branch-head')).toBeNull();
    // Only now is a second group worth offering.
    expect(ui.byText('button.add-row', 'Add or', '.conditions')).not.toBeNull();
  });

  it('marks the device picker, which is wider than the rest of the row', async () => {
    const ui = await openRule(legacyRule);
    // The width lives in the stylesheet, the class is what hangs it there.
    const first = ui.document.querySelector('.condition-group .rule-row')!;
    expect(first.querySelector('select')!.classList.contains('device-picker')).toBe(true);
    // Never `device`, which is the card class and would paint it like one.
    expect(first.querySelector('select')!.classList.contains('device')).toBe(false);
  });

  it('offers a not toggle per group', async () => {
    const ui = await openRule(legacyRule);
    const negate = ui.byText('.condition-group label.toggle', 'Not');
    expect(negate).not.toBeNull();
  });

  it('sends an expression when saved, not a flat list', async () => {
    const ui = await openRule(legacyRule);
    await ui.click(ui.byText('button.add-row', 'Add or', '.conditions'));
    await ui.click(ui.byText('button.primary', 'Save'));

    // The first request to that path is the listing, which carries no body.
    const saved = ui.requests.findLast((request) => request.body !== undefined)?.body as {
      branches: { when: { kind: string; nodes: unknown[] } }[];
    };
    // Conditions live on the branch now, not on the rule.
    expect(saved.branches[0]?.when.kind).toBe('any');
    expect(saved.branches[0]?.when.nodes).toHaveLength(2);
  });

  it('leaves an expression too deep for it alone', async () => {
    const deep = {
      ...legacyRule,
      conditions: undefined,
      when: { kind: 'any', nodes: [{ kind: 'any', nodes: [test_('0xb')] }] },
    };
    const ui = await openRule(deep);

    expect(ui.document.querySelectorAll('.condition-group')).toHaveLength(0);
    expect(ui.document.body.textContent).toContain('edited by hand');
  });
});

describe('the trigger list', () => {
  it('shows a rule stored with one trigger as one row', async () => {
    const ui = await openRule(legacyRule);
    const rows = ui.document.querySelectorAll('#view-automation .rule-row');
    // One trigger, one condition, one action.
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(ui.byText('button.add-row', '+ trigger', '.triggers')).not.toBeNull();
  });

  it('adds a second trigger joined with or', async () => {
    const ui = await openRule(legacyRule);
    const before = ui.document.querySelectorAll('#view-automation .rule-row').length;

    await ui.click(ui.byText('button.add-row', '+ trigger', '.triggers'));

    expect(ui.document.querySelectorAll('#view-automation .rule-row')).toHaveLength(before + 1);
  });

  it('leaves the triggers unjoined, since the heading says what they are', async () => {
    const ui = await openRule(legacyRule);
    await ui.click(ui.byText('button.add-row', '+ trigger', '.triggers'));

    expect(ui.byText('span.joiner', 'or', '.triggers')).toBeNull();
    expect(ui.document.querySelectorAll('.triggers .rule-row')).toHaveLength(2);
  });

  it('sends a list of triggers when saved', async () => {
    const ui = await openRule(legacyRule);
    await ui.click(ui.byText('button.add-row', '+ trigger', '.triggers'));
    await ui.click(ui.byText('button.primary', 'Save'));

    const saved = ui.requests.findLast((request) => request.body !== undefined)?.body as {
      triggers: unknown[];
      trigger?: unknown;
    };
    expect(saved.triggers).toHaveLength(2);
    // The single field is not sent alongside the list.
    expect(saved.trigger).toBeUndefined();
  });
});

describe('branches', () => {
  it('shows a rule with one outcome as one branch, unadorned', async () => {
    const ui = await openRule(legacyRule);
    // Nothing to number or remove when there is only one.
    expect(ui.document.querySelectorAll('.branch')).toHaveLength(1);
    expect(ui.document.querySelector('.branch-head button[title^="Remove outcome"]')).toBeNull();
    expect(ui.byText('button.add-row', '+ outcome')).not.toBeNull();
  });

  it('adds an outcome that can take its own condition', async () => {
    const ui = await openRule(legacyRule);
    await ui.click(ui.byText('button.add-row', '+ outcome'));

    expect(ui.document.querySelectorAll('.branch')).toHaveLength(2);
    // Every outcome gets a condition editor, the last one included.
    expect(ui.document.querySelectorAll('.branch .conditions')).toHaveLength(2);
  });

  it('gives every outcome its own actions', async () => {
    const ui = await openRule(legacyRule);
    await ui.click(ui.byText('button.add-row', '+ outcome'));
    expect(ui.document.querySelectorAll('.branch .actions')).toHaveLength(2);
  });

  it('says which outcome the remove button removes, without spelling it out', async () => {
    const ui = await openRule(legacyRule);
    await ui.click(ui.byText('button.add-row', '+ outcome'));

    const buttons = [...ui.document.querySelectorAll('.branch-head-right button.add-row')];
    // A plain cross, with the number kept in the tooltip.
    expect(buttons.map((button) => button.textContent)).toEqual(['✕', '✕']);
    expect(buttons.map((button) => button.getAttribute('title'))).toEqual([
      'Remove outcome 1',
      'Remove outcome 2',
    ]);
  });

  it('names an outcome, and sends the name when saved', async () => {
    const ui = await openRule(legacyRule);
    const name = ui.document.querySelector('input.outcome-name') as HTMLInputElement;
    expect(name).not.toBeNull();

    name.value = 'nobody home';
    name.dispatchEvent(new ui.window.Event('input'));
    await ui.settle();
    await ui.click(ui.byText('button.primary', 'Save'));

    const saved = ui.requests.findLast((request) => request.body !== undefined)?.body as {
      branches: { label?: string }[];
    };
    expect(saved.branches[0]?.label).toBe('nobody home');
  });

  it('shows a name that was stored', async () => {
    const named = {
      ...legacyRule,
      conditions: undefined,
      branches: [{ label: 'dusk', when: test_('0xb'), actions: [{ ...ref('0xc'), value: 'ON' }] }],
    };
    const ui = await openRule(named);
    const name = ui.document.querySelector('input.outcome-name') as HTMLInputElement;
    expect(name.value).toBe('dusk');
  });

  it('has no name box on a condition', async () => {
    const ui = await openRule(legacyRule);
    expect(ui.document.querySelector('.condition-group input.row-name')).toBeNull();
  });

  it('adds an action from the end of the last action row', async () => {
    const ui = await openRule(legacyRule);
    const rows = () => ui.document.querySelectorAll('.actions .rule-row');
    const before = rows().length;

    const add = ui.byText('button.add-row', '+ action', '.actions');
    // On the row rather than under it, like the trigger and condition buttons.
    expect(add!.closest('.rule-tail')).not.toBeNull();

    await ui.click(add);
    expect(rows()).toHaveLength(before + 1);
    // It follows the list down rather than staying on the first row.
    expect(
      ui.byText('button.add-row', '+ action', '.actions')!.closest('.rule-row'),
    ).toBe(rows()[before]);
  });

  it('sends a list of branches when saved', async () => {
    const ui = await openRule(legacyRule);
    await ui.click(ui.byText('button.add-row', '+ outcome'));
    await ui.click(ui.byText('button.primary', 'Save'));

    const saved = ui.requests.findLast((request) => request.body !== undefined)?.body as {
      branches: { when?: unknown; actions: unknown[] }[];
      actions?: unknown;
      when?: unknown;
    };
    expect(saved.branches).toHaveLength(2);
    expect(saved.branches[0]?.when).toBeDefined();
    // A new outcome starts without a condition, which means it always holds.
    expect(saved.branches[1]?.when).toBeUndefined();
    // The single outcome fields are not sent alongside the list.
    expect(saved.actions).toBeUndefined();
    expect(saved.when).toBeUndefined();
  });

  it('removes an outcome again', async () => {
    const ui = await openRule(legacyRule);
    await ui.click(ui.byText('button.add-row', '+ outcome'));
    // The tooltip says which one is going.
    await ui.click(ui.document.querySelector('.branch-head button[title="Remove outcome 2"]'));
    expect(ui.document.querySelectorAll('.branch')).toHaveLength(1);
  });
});
