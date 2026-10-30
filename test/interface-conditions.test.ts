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

/** The line on the first outcome's heading, saying how its groups are taken together. */
const outcomeLine = (ui: { document: Document }) =>
  ui.document.querySelector('.branch .branch-head .combination select') as HTMLSelectElement;

async function openRule(rule: unknown) {
  const ui = await openInterface({ state: { devices }, rules: [rule] });
  await ui.click(ui.byText('button.tab', 'Rules'));
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

  it('offers a second group once there is one, joined the way the outcome line says', async () => {
    const ui = await openRule(legacyRule);
    expect(ui.byText('button.add-row', '+ condition group', '.conditions')).not.toBeNull();

    await ui.click(ui.byText('button.add-row', '+ condition group', '.conditions'));
    expect(ui.document.querySelectorAll('.condition-group')).toHaveLength(2);
    // All of them by default, so this and that.
    expect(ui.byText('p.joiner', 'and')).not.toBeNull();

    await ui.pick(outcomeLine(ui), 'any');
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
    const heading = () => ui.document.querySelector('.branch .branch-head-left') as HTMLElement;
    expect(ui.document.querySelectorAll('.condition-group')).toHaveLength(0);

    // With no rows yet the button has nowhere to sit but the heading's line,
    // and on the first outcome it is the whole of it.
    expect(ui.byText('button.add-row', '+ condition', '.branch-head')).not.toBeNull();
    expect(heading().textContent?.trim()).toBe('+ condition');

    await ui.click(ui.byText('button.add-row', '+ condition', '.branch-head'));
    expect(ui.document.querySelectorAll('.condition-group')).toHaveLength(1);
    // Once there is a row to hang it off, it is no longer up in the heading,
    // which says what follows instead.
    expect(ui.byText('button.add-row', '+ condition', '.branch-head')).toBeNull();
    expect(ui.byText('p.group-title', 'And when', '.branch-head')).not.toBeNull();
    expect(ui.byText('button.add-row', '+ condition group', '.conditions')).not.toBeNull();
    // One group is all of one, with nothing to choose.
    expect(outcomeLine(ui)).toBeNull();

    // Two are worth saying how to take together, on the heading's own line.
    await ui.click(ui.byText('button.add-row', '+ condition group', '.conditions'));
    expect(outcomeLine(ui).value).toBe('all');
    expect(heading().contains(outcomeLine(ui))).toBe(true);
    expect(ui.document.querySelector('.branch .conditions > .combination')).toBeNull();

    // And none again once one of them goes.
    await ui.click(ui.byText('button.add-row', 'Remove group', '.conditions'));
    expect(outcomeLine(ui)).toBeNull();
  });

  it('starts a later outcome at or, and says or when once it has a condition', async () => {
    const ui = await openRule(legacyRule);
    await ui.click(ui.byText('button.add-row', '+ outcome'));
    const later = () =>
      ui.document.querySelectorAll('.branch .branch-head-left')[1] as HTMLElement;

    expect(later().textContent?.replace(/\s+/g, ' ').trim()).toBe('Or+ condition');
    await ui.click(later().querySelector('button.add-row'));
    expect(later().querySelector('p.group-title')?.textContent).toBe('Or when');
  });

  it('opens a row with a room picker and then a device picker', async () => {
    const ui = await openRule(legacyRule);
    const [room, device] = [
      ...ui.document.querySelectorAll('.condition-group .rule-row select'),
    ] as HTMLSelectElement[];
    expect(room!.classList.contains('room-picker')).toBe(true);
    expect(device!.classList.contains('device-picker')).toBe(true);
    // Never `device`, which is the card class and would paint it like one.
    expect(device!.classList.contains('device')).toBe(false);
  });

  it('says per group how its conditions are taken together, all of them to begin with', async () => {
    const ui = await openRule(legacyRule);
    const line = ui.document.querySelector('.condition-group .combination') as HTMLElement;
    const pick = line.querySelector('select') as HTMLSelectElement;

    expect([...pick.options].map((option) => option.textContent)).toEqual([
      'All',
      'At least 1',
      'None',
      'Not all',
    ]);
    expect(pick.value).toBe('all');
    expect(line.textContent).toContain('are true');
    expect(ui.document.querySelector('.condition-group label.toggle')).toBeNull();
  });

  it('says is true for at least 1, and joins its conditions the way the line says', async () => {
    const ui = await openRule(legacyRule);
    await ui.click(ui.byText('button.add-row', '+ condition', '.conditions'));
    const line = () => ui.document.querySelector('.condition-group .combination') as HTMLElement;
    const words = () =>
      [...ui.document.querySelectorAll('.condition-group .joiner')].map((word) => word.textContent);

    expect(words()).toEqual(['and']);

    await ui.pick(line().querySelector('select'), 'any');
    expect(line().textContent).toContain('is true');
    expect(words()).toEqual(['or']);

    // None says not in front of the first one as well, on a line of its own.
    await ui.pick(line().querySelector('select'), 'none');
    expect(line().textContent).toContain('are true');
    expect(words()).toEqual(['not', 'and not']);
    const first = ui.document.querySelector('.condition-group .rule-row') as HTMLElement;
    expect(first.previousElementSibling?.matches('p.joiner')).toBe(true);
    expect(first.previousElementSibling?.textContent).toBe('not');
    expect(first.querySelector('.joiner')?.textContent).toBe('and not');

    await ui.pick(line().querySelector('select'), 'notAll');
    expect(words()).toEqual(['or']);
  });

  it('joins the groups of an outcome the same way, not in front of the first for none', async () => {
    const ui = await openRule(legacyRule);
    await ui.click(ui.byText('button.add-row', '+ condition group', '.conditions'));
    const words = () =>
      [...ui.document.querySelectorAll('.conditions > p.joiner')].map((word) => word.textContent);

    expect(words()).toEqual(['and']);
    await ui.pick(outcomeLine(ui), 'any');
    expect(words()).toEqual(['or']);
    await ui.pick(outcomeLine(ui), 'none');
    expect(words()).toEqual(['not', 'and not']);
    // In front of the first group, not after it.
    const conditions = ui.document.querySelector('.branch .conditions') as HTMLElement;
    expect(conditions.firstElementChild?.textContent).toBe('not');
    await ui.pick(outcomeLine(ui), 'notAll');
    expect(words()).toEqual(['or']);
  });

  it('reads a saved not as not all, and several groups as at least 1 of them', async () => {
    const ui = await openRule({
      ...legacyRule,
      conditions: undefined,
      when: {
        kind: 'any',
        nodes: [{ kind: 'not', node: { kind: 'all', nodes: [test_('0xb'), test_('0xc')] } }, test_('0xc')],
      },
    });

    expect(outcomeLine(ui).value).toBe('any');
    const groups = [...ui.document.querySelectorAll('.condition-group .combination select')] as HTMLSelectElement[];
    expect(groups.map((pick) => pick.value)).toEqual(['notAll', 'all']);
  });

  it('saves what the lines say, and reads it back the same', async () => {
    const ui = await openRule(legacyRule);
    const groupLine = () => ui.document.querySelector('.condition-group .combination select');
    await ui.pick(groupLine(), 'any');
    await ui.click(ui.byText('button.primary', 'Save', '#automation'));

    const saved = () =>
      ui.requests.findLast((request) => request.body !== undefined)?.body as {
        branches: { when: { kind: string; node?: { kind: string; nodes: unknown[] } } }[];
      };
    // A group of one still says at least 1, so it reads back as it was left.
    expect(saved().branches[0]?.when).toEqual({ kind: 'all', nodes: [{ kind: 'any', nodes: [test_('0xb')] }] });

    const again = await openRule({ ...legacyRule, conditions: undefined, when: saved().branches[0]?.when });
    expect((again.document.querySelector('.condition-group .combination select') as HTMLSelectElement).value).toBe('any');

    // Saving reloads the rule as it was handed out, a group of all of one,
    // which under none is still written as a group of its own.
    await ui.click(ui.byText('button.add-row', '+ condition group', '.conditions'));
    await ui.pick(outcomeLine(ui), 'none');
    await ui.click(ui.byText('button.primary', 'Save', '#automation'));
    const when = saved().branches[0]?.when;
    expect(when?.kind).toBe('not');
    expect(when?.node?.kind).toBe('any');
    expect(when?.node?.nodes).toHaveLength(2);
    expect(when?.node?.nodes[0]).toEqual({ kind: 'all', nodes: [test_('0xb')] });
  });

  it('reads one group under a line of its own as that group, turned round where the line said so', async () => {
    const one = { kind: 'all', nodes: [test_('0xb'), test_('0xc')] };
    const read = async (when: unknown) => {
      const ui = await openRule({ ...legacyRule, conditions: undefined, when });
      expect(outcomeLine(ui)).toBeNull();
      return (ui.document.querySelector('.condition-group .combination select') as HTMLSelectElement).value;
    };
    expect(await read({ kind: 'not', node: { kind: 'any', nodes: [one] } })).toBe('notAll');
    expect(await read({ kind: 'not', node: { kind: 'all', nodes: [{ kind: 'any', nodes: [test_('0xb')] }] } })).toBe('none');
    expect(await read({ kind: 'any', nodes: [{ kind: 'not', node: { kind: 'any', nodes: [test_('0xb')] } }] })).toBe('none');
  });

  it('sends an expression when saved, not a flat list', async () => {
    const ui = await openRule(legacyRule);
    await ui.click(ui.byText('button.add-row', '+ condition group', '.conditions'));
    await ui.pick(outcomeLine(ui), 'any');
    await ui.click(ui.byText('button.primary', 'Save', '#automation'));

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
      when: { kind: 'any', nodes: [{ kind: 'all', nodes: [{ kind: 'any', nodes: [test_('0xb')] }] }] },
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

  it('joins the triggers with or, since any of them sets the rule off', async () => {
    const ui = await openRule(legacyRule);
    await ui.click(ui.byText('button.add-row', '+ trigger', '.triggers'));

    const rows = ui.document.querySelectorAll('.triggers .rule-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector('.joiner')?.textContent).toBe('or');
    expect(rows[1]?.querySelector('.joiner')).toBeNull();
  });

  it('sends a list of triggers when saved', async () => {
    const ui = await openRule(legacyRule);
    await ui.click(ui.byText('button.add-row', '+ trigger', '.triggers'));
    await ui.click(ui.byText('button.primary', 'Save', '#automation'));

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

    const buttons = [...ui.document.querySelectorAll('.branch-head-right button[title^="Remove"]')];
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
    await ui.click(ui.byText('button.primary', 'Save', '#automation'));

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

  it('adds a wait next to an outcome, half a minute to begin with', async () => {
    const ui = await openRule(legacyRule);
    // No wait until one is asked for.
    expect(ui.document.querySelectorAll('#automation .wait-box')).toHaveLength(0);
    const add = ui.byText('button.add-row', '+ wait', '#automation');
    expect(add?.parentElement).toBe(ui.byText('button.add-row', '+ outcome', '#automation')?.parentElement);

    await ui.click(add);
    const boxes = [...ui.document.querySelectorAll('#automation .wait-block .wait-box')] as HTMLInputElement[];
    expect(boxes.map((box) => box.value)).toEqual(['00', '30']);
    expect(ui.byText('label', 'Wait (mm:ss)', '#automation .wait-block')).not.toBeNull();
    // After the outcome it was added below.
    const branch = ui.document.querySelector('#automation .branch') as HTMLElement;
    const wait = ui.document.querySelector('#automation .wait-block') as HTMLElement;
    expect(branch.compareDocumentPosition(wait) & 4).toBeTruthy();
  });

  it('sends a wait above the first outcome as the rule’s own, and one lower down on its outcome', async () => {
    const ui = await openRule(legacyRule);
    await ui.click(ui.byText('button.add-row', '+ outcome'));
    await ui.click(ui.byText('button.add-row', '+ wait'));
    const saved = () =>
      ui.requests.findLast((request) => request.body !== undefined)?.body as {
        waitMs?: number;
        branches: { waitMs?: number }[];
      };

    // Up past the second outcome: between the two.
    await ui.click(ui.document.querySelector('.wait-block button[title="Move wait up"]'));
    await ui.click(ui.byText('button.primary', 'Save', '#automation'));
    expect(saved().waitMs).toBeUndefined();
    expect(saved().branches.map((branch) => branch.waitMs)).toEqual([undefined, 30_000]);
    // Nothing of the editor's own blocks goes with it.
    expect(saved().branches).toHaveLength(2);
  });

  it('sends a wait moved to the top as the rule’s own', async () => {
    const ui = await openRule(legacyRule);
    await ui.click(ui.byText('button.add-row', '+ wait'));
    await ui.click(ui.document.querySelector('.wait-block button[title="Move wait up"]'));
    await ui.click(ui.byText('button.primary', 'Save', '#automation'));

    const saved = ui.requests.findLast((request) => request.body !== undefined)?.body as {
      waitMs?: number;
      branches: { waitMs?: number }[];
    };
    expect(saved.waitMs).toBe(30_000);
    expect(saved.branches.map((branch) => branch.waitMs)).toEqual([undefined]);
  });

  it('will not save a wait with no outcome after it, two in a row, or one with no time', async () => {
    const ui = await openRule(legacyRule);
    const error = () => ui.document.querySelector('#automation .rule-footer .error')?.textContent;
    const save = () => ui.click(ui.byText('button.primary', 'Save', '#automation'));
    const sent = () => ui.requests.filter((request) => request.body !== undefined).length;
    const before = sent();

    await ui.click(ui.byText('button.add-row', '+ wait'));
    await save();
    expect(error()).toBe('A wait needs an outcome after it');

    await ui.click(ui.document.querySelector('.wait-block button[title="Move wait up"]'));
    await ui.click(ui.byText('button.add-row', '+ wait'));
    await ui.click(ui.document.querySelectorAll('.wait-block button[title="Move wait up"]')[1]!);
    await save();
    expect(error()).toBe('Two waits in a row: make them one');

    await ui.click(ui.document.querySelector('.wait-block button[title="Remove wait"]'));
    for (const box of ui.document.querySelectorAll('.wait-block .wait-box') as NodeListOf<HTMLInputElement>) {
      box.value = '';
      box.dispatchEvent(new ui.window.Event('input'));
    }
    await ui.settle();
    await save();
    expect(error()).toBe('A wait needs a time');
    expect(sent()).toBe(before);
  });

  it('will not take more than fifty nine seconds', async () => {
    const ui = await openRule(legacyRule);
    await ui.click(ui.byText('button.add-row', '+ wait'));
    const [, seconds] = [
      ...ui.document.querySelectorAll('#automation .wait-box'),
    ] as HTMLInputElement[];

    seconds!.value = '90';
    seconds!.dispatchEvent(new ui.window.Event('input'));
    await ui.settle();

    // Sixty seconds is a minute, and the box beside it is for those.
    expect(seconds!.value).toBe('59');
  });

  it('fills the box beside a wait in, and leaves both empty once emptied', async () => {
    const ui = await openRule(legacyRule);
    await ui.click(ui.byText('button.add-row', '+ wait'));
    const [minutes, seconds] = [
      ...ui.document.querySelectorAll('#automation .wait-box'),
    ] as HTMLInputElement[];

    seconds!.value = '';
    seconds!.dispatchEvent(new ui.window.Event('input'));
    minutes!.value = '2';
    minutes!.dispatchEvent(new ui.window.Event('input'));
    seconds!.dispatchEvent(new ui.window.Event('blur'));
    await ui.settle();
    expect(seconds!.value).toBe('00');

    minutes!.value = '';
    minutes!.dispatchEvent(new ui.window.Event('input'));
    seconds!.value = '';
    seconds!.dispatchEvent(new ui.window.Event('input'));
    for (const box of [minutes, seconds]) {
      box!.dispatchEvent(new ui.window.Event('blur'));
    }
    await ui.settle();

    // Empty is what having no time looks like.
    expect([minutes!.value, seconds!.value]).toEqual(['', '']);
  });

  it('reads a stored wait back as a clock, in a block above the first outcome', async () => {
    const ui = await openRule({ ...legacyRule, waitMs: 125_000 });
    const boxes = [...ui.document.querySelectorAll('#automation .wait-block .wait-box')] as HTMLInputElement[];
    expect(boxes.map((box) => box.value)).toEqual(['02', '05']);
    const branch = ui.document.querySelector('#automation .branch') as HTMLElement;
    const wait = ui.document.querySelector('#automation .wait-block') as HTMLElement;
    expect(wait.compareDocumentPosition(branch) & 4).toBeTruthy();
  });

  it('reads a wait stored on an outcome back as a block in front of it', async () => {
    const outcome = { actions: [{ ...ref('0xc'), value: 'ON' }] };
    const ui = await openRule({
      ...legacyRule,
      conditions: undefined,
      branches: [outcome, { ...outcome, waitMs: 10_000 }],
    });
    const order = [...ui.document.querySelectorAll('#automation .branch, #automation .wait-block')].map(
      (block) => block.className,
    );
    expect(order).toEqual(['branch', 'wait-block', 'branch']);
  });

  it('moves an outcome up and down a place, but not past either end', async () => {
    const ui = await openRule(legacyRule);
    const up = (index: number) =>
      ui.document.querySelectorAll('.branch button[title="Move outcome up"]')[index] as HTMLButtonElement;
    const down = (index: number) =>
      ui.document.querySelectorAll('.branch button[title="Move outcome down"]')[index] as HTMLButtonElement;

    // Between the name and the cross.
    const right = ui.document.querySelector('.branch .branch-head-right') as HTMLElement;
    expect([...right.children].map((child) => child.textContent || child.className)).toEqual([
      'outcome-name',
      '\u2191',
      '\u2193',
    ]);
    expect(up(0).disabled).toBe(true);
    expect(down(0).disabled).toBe(true);

    await ui.click(ui.byText('button.add-row', '+ outcome'));
    const name = ui.document.querySelectorAll('input.outcome-name')[1] as HTMLInputElement;
    name.value = 'second';
    name.dispatchEvent(new ui.window.Event('input'));
    expect(up(0).disabled).toBe(true);
    expect(down(0).disabled).toBe(false);
    expect(up(1).disabled).toBe(false);
    expect(down(1).disabled).toBe(true);

    await ui.click(up(1));
    const names = [...ui.document.querySelectorAll('input.outcome-name')].map(
      (input) => (input as HTMLInputElement).value,
    );
    expect(names).toEqual(['second', '']);
    // First now, with no condition, it is a button and nothing else; the one
    // below it with a condition is or when.
    const headings = [...ui.document.querySelectorAll('.branch .branch-head-left')];
    expect(headings[0]?.querySelector('p.group-title')).toBeNull();
    expect(headings[1]?.querySelector('p.group-title')?.textContent).toBe('Or when');
  });

  it('sends a list of branches when saved', async () => {
    const ui = await openRule(legacyRule);
    await ui.click(ui.byText('button.add-row', '+ outcome'));
    await ui.click(ui.byText('button.primary', 'Save', '#automation'));

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

describe('a number', () => {
  const sensor = {
    ...device('0xd', 'hall_sensor'),
    exposure: { properties: [], room: 'Hal' },
    properties: [
      {
        key: 'illuminance',
        label: 'Illuminance',
        type: 'numeric',
        unit: 'lx',
        category: 'primary',
        endpoint: '',
        readable: true,
        writable: false,
        publishable: false,
      },
    ],
  };
  const lux = { sourceId: 'zigbee', deviceId: '0xd', propertyKey: 'illuminance' };
  const dark = {
    id: 'r2',
    name: 'Dark hall',
    enabled: true,
    triggers: [{ ...lux, match: { kind: 'below', value: 60 } }],
    branches: [
      {
        when: { kind: 'test', ...lux, match: { kind: 'below', value: 60 } },
        actions: [{ ...ref('0xc'), value: 'ON' }],
      },
    ],
  };

  const offered = (row: Element) =>
    [...row.querySelectorAll('.rule-tail select option')].map((option) => option.textContent);

  it('rises above or falls below as a trigger, and is above or below as a condition', async () => {
    const ui = await openInterface({ state: { devices: [...devices, sensor] }, rules: [dark] });
    await ui.click(ui.byText('button.tab', 'Rules'));
    await ui.openCard(ui.document.querySelector('.rule') as HTMLDetailsElement);

    const trigger = ui.document.querySelector('.triggers .rule-row')!;
    expect(offered(trigger)).toContain('falls below');
    expect(offered(trigger)).not.toContain('is below');

    const condition = ui.document.querySelector('.condition-group .rule-row')!;
    expect(offered(condition)).toEqual(expect.arrayContaining(['is above', 'is below']));
    expect(offered(condition)).not.toContain('falls below');
    const kinds = condition.querySelector('.rule-tail select') as HTMLSelectElement;
    expect(kinds.selectedOptions[0]?.textContent).toBe('is below');
  });

  it('stays a test when a condition goes from a time back to a device', async () => {
    const atNight = {
      ...dark,
      branches: [{ ...dark.branches[0], when: { kind: 'time', at: '22:00', side: 'after' } }],
    };
    const ui = await openInterface({ state: { devices: [...devices, sensor] }, rules: [atNight] });
    await ui.click(ui.byText('button.tab', 'Rules'));
    await ui.openCard(ui.document.querySelector('.rule') as HTMLDetailsElement);

    const room = ui.document.querySelector('.condition-group .rule-row select') as HTMLSelectElement;
    room.value = 'Hal';
    room.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();
    await ui.click(ui.byText('button.primary', 'Save', '#automation'));

    const saved = ui.requests.findLast((request) => request.body !== undefined)?.body as {
      branches: { when: unknown }[];
    };
    expect(saved.branches[0]?.when).toMatchObject({ kind: 'test', deviceId: '0xd' });
  });
});
