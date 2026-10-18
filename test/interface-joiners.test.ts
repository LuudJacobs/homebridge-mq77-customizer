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
    },
  ],
  exposure: { properties: [] },
  state: {},
  lastSeen: {},
});

const devices = () => [device('0xa', 'lamp_a'), device('0xb', 'lamp_b')];
const ref = (deviceId: string) => ({ sourceId: 'zigbee', deviceId, propertyKey: 'state' });

async function openRule(rule: unknown, canNotify = false) {
  const ui = await openInterface({ state: { devices: devices(), canNotify }, rules: [rule] });
  await ui.click(ui.byText('button.tab', 'Automation'));
  await ui.openCard(ui.document.querySelector('.rule') as HTMLDetailsElement);
  return ui;
}

/** The word at the end of each row, or nothing where there is none. */
const joiners = (rows: NodeListOf<Element>) =>
  [...rows].map((row) => row.querySelector('.joiner')?.textContent ?? null);

const rule = (over: Record<string, unknown>) => ({
  id: 'r1',
  name: 'Regel',
  enabled: true,
  triggers: [{ ...ref('0xa'), match: { kind: 'changedTo', value: 'ON' } }],
  branches: [{ actions: [{ ...ref('0xb'), value: 'ON' }] }],
  ...over,
});

describe('the word at the end of a row', () => {
  it('follows a time among the conditions, as it follows a device', async () => {
    const ui = await openRule(
      rule({
        branches: [
          {
            when: {
              kind: 'all',
              nodes: [{ kind: 'time', at: '22:00', side: 'after' }],
            },
            actions: [{ ...ref('0xb'), value: 'ON' }],
          },
        ],
      }),
    );
    await ui.click(ui.byText('button.add-row', '+ condition', '.conditions'));

    const rows = ui.document.querySelectorAll('.condition-group .rule-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector('input.time-at')).not.toBeNull();
    expect(joiners(rows)).toEqual(['and', null]);
  });

  it('is or between triggers, a time among them too', async () => {
    const ui = await openRule(
      rule({
        triggers: [
          { kind: 'time', at: '07:00' },
          { ...ref('0xa'), match: { kind: 'changedTo', value: 'ON' } },
        ],
      }),
    );
    await ui.click(ui.byText('button.add-row', '+ trigger', '.triggers'));
    expect(joiners(ui.document.querySelectorAll('.triggers .rule-row'))).toEqual(['or', 'or', null]);
  });

  it('is and between actions, a notification among them too', async () => {
    const ui = await openRule(
      rule({
        branches: [
          {
            actions: [
              { kind: 'notify', message: 'Hallo' },
              { ...ref('0xb'), value: 'ON' },
            ],
          },
        ],
      }),
      true,
    );
    await ui.click(ui.byText('button.add-row', '+ action', '.actions'));
    expect(joiners(ui.document.querySelectorAll('.actions .rule-row'))).toEqual([
      'and',
      'and',
      null,
    ]);
  });

  it('sits before the button that adds the next row, on the last one', async () => {
    const ui = await openRule(rule({}));
    await ui.click(ui.byText('button.add-row', '+ action', '.actions'));
    const [first, last] = [...ui.document.querySelectorAll('.actions .rule-row')];
    // The button moves to the new last row, and the word takes its place.
    expect(first?.querySelector('.rule-tail')?.lastElementChild?.textContent).toBe('and');
    expect(last?.querySelector('.rule-tail')?.lastElementChild?.textContent).toBe('+ action');
  });
});
