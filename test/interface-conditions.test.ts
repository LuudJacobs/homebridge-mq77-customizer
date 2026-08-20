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
  card.open = true;
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
    expect(ui.byText('button.add-row', 'Add or')).not.toBeNull();

    await ui.click(ui.byText('button.add-row', 'Add or'));

    expect(ui.document.querySelectorAll('.condition-group')).toHaveLength(2);
    expect(ui.byText('p.joiner', 'or')).not.toBeNull();
  });

  it('adds a test inside a group, joined with and', async () => {
    const ui = await openRule(legacyRule);
    await ui.click(ui.byText('button.add-row', 'Add and'));

    expect(ui.document.querySelectorAll('.condition-group .rule-row')).toHaveLength(2);
    expect(ui.byText('span.joiner', 'and')).not.toBeNull();
  });

  it('starts a rule with no conditions at one button, and builds from it', async () => {
    const ui = await openRule({ ...legacyRule, conditions: [] });
    expect(ui.document.querySelectorAll('.condition-group')).toHaveLength(0);

    await ui.click(ui.byText('button.add-row', 'Add condition'));
    expect(ui.document.querySelectorAll('.condition-group')).toHaveLength(1);
    // Only now is a second group worth offering.
    expect(ui.byText('button.add-row', 'Add or')).not.toBeNull();
  });

  it('offers a not toggle per group', async () => {
    const ui = await openRule(legacyRule);
    const negate = ui.byText('.condition-group label.toggle', 'Not');
    expect(negate).not.toBeNull();
  });

  it('sends an expression when saved, not a flat list', async () => {
    const ui = await openRule(legacyRule);
    await ui.click(ui.byText('button.add-row', 'Add or'));
    await ui.click(ui.byText('button.primary', 'Save'));

    // The first request to that path is the listing, which carries no body.
    const saved = ui.requests.findLast((request) => request.body !== undefined)?.body as {
      when: { kind: string; nodes: unknown[] };
    };
    expect(saved.when.kind).toBe('any');
    expect(saved.when.nodes).toHaveLength(2);
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
