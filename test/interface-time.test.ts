import { describe, expect, it } from 'vitest';

import { openInterface } from './helpers/interface.js';

const property = (key: string, label: string) => ({
  key,
  label,
  semantic: key,
  type: 'binary',
  category: 'primary',
  endpoint: '',
  readable: true,
  writable: true,
  publishable: true,
  role: 'power',
  onValue: 'ON',
  offValue: 'OFF',
});

const device = (deviceId: string, name: string, type?: string) => ({
  sourceId: 'zigbee',
  deviceId,
  name,
  topic: `zigbee2mqtt/${name}`,
  manufacturer: 'SONOFF',
  model: 'ZBMINIL2',
  rulesOnly: false,
  renameable: false,
  endpoints: [''],
  properties: [property('state', 'State')],
  exposure: { properties: [], label: name, ...(type ? { type } : {}) },
  state: {},
  lastSeen: {},
});

const devices = [device('0xa', 'lamp', 'light'), device('0xb', 'remote', 'controller')];

const ref = (deviceId: string) => ({ sourceId: 'zigbee', deviceId, propertyKey: 'state' });

const automation = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  kind: 'standard',
  name: 'Evening',
  enabled: true,
  triggers: [{ ...ref('0xb'), match: { kind: 'changedTo', value: 'ON' } }],
  actions: [{ ...ref('0xa'), value: 'ON' }],
  ...over,
});

async function openRule(rule: unknown, tab = 'Automation') {
  const ui = await openInterface({ state: { devices }, rules: [rule] });
  await ui.click(ui.byText('button.tab', tab));
  const card = ui.document.querySelector('.rule') as HTMLDetailsElement;
  await ui.openCard(card);
  return ui;
}

/** The first trigger row's device picker, wherever the panel keeps it. */
const pickerOptions = (ui: { document: Document }, view = '#automation') =>
  [...(ui.document.querySelector(`${view} .device-picker`) as HTMLSelectElement).options].map(
    (option) => option.textContent,
  );

describe('picking a time', () => {
  it('offers Time at the bottom of the trigger picker, under the devices', async () => {
    const ui = await openRule(automation());
    const options = pickerOptions(ui);

    expect(options.at(-1)).toBe('Time');
    // And it is the only thing there that is not a device.
    expect(options.slice(0, -1)).toEqual(['lamp', 'remote']);
  });

  it('turns the row into a time and a set of days when Time is chosen', async () => {
    const ui = await openRule(automation());
    const picker = ui.document.querySelector('.triggers .device-picker') as HTMLSelectElement;

    picker.value = '__time';
    picker.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();

    const at = ui.document.querySelector('.triggers .time-at') as HTMLInputElement;
    expect(at).not.toBeNull();
    expect(at.value).toBe('07:00');
    // Seven days, all ticked, since nothing set means every day.
    const days = [...ui.document.querySelectorAll('.triggers .day-picker input')] as HTMLInputElement[];
    expect(days).toHaveLength(7);
    expect(days.every((box) => box.checked)).toBe(true);
    // The property and match pickers are gone: a time names neither.
    expect(ui.document.querySelector('.triggers .rule-tail select')).toBeNull();
  });

  it('sends the time, and the days when they are not every day', async () => {
    const ui = await openRule(automation({ triggers: [{ kind: 'time', at: '22:00' }] }));

    const at = ui.document.querySelector('.triggers .time-at') as HTMLInputElement;
    at.value = '23:15';
    at.dispatchEvent(new ui.window.Event('change'));

    const monday = ui.document.querySelector('.triggers .day-picker input') as HTMLInputElement;
    monday.checked = false;
    monday.dispatchEvent(new ui.window.Event('change'));

    await ui.click(ui.byText('button.primary', 'Save', '#automation'));
    const saved = ui.requests.findLast((request) => request.body !== undefined)?.body as {
      triggers: { kind: string; at: string; days?: string[] }[];
    };

    expect(saved.triggers[0]).toMatchObject({ kind: 'time', at: '23:15' });
    expect(saved.triggers[0]?.days).toEqual(['tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
  });

  it('goes back to a device, keeping nothing of the time', async () => {
    const ui = await openRule(automation({ triggers: [{ kind: 'time', at: '22:00' }] }));
    const picker = ui.document.querySelector('.triggers .device-picker') as HTMLSelectElement;

    picker.value = 'zigbee|0xa';
    picker.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();

    expect(ui.document.querySelector('.triggers .time-at')).toBeNull();
    await ui.click(ui.byText('button.primary', 'Save', '#automation'));
    const saved = ui.requests.findLast((request) => request.body !== undefined)?.body as {
      triggers: Record<string, unknown>[];
    };
    expect(saved.triggers[0]).toMatchObject({ deviceId: '0xa', propertyKey: 'state' });
    expect(saved.triggers[0]?.at).toBeUndefined();
    expect(saved.triggers[0]?.kind).toBeUndefined();
  });
});

describe('a time in the lists', () => {
  it('carries a clock where a device would carry its kind', async () => {
    const ui = await openInterface({
      state: { devices },
      rules: [automation({ triggers: [{ kind: 'time', at: '22:00' }] })],
    });
    await ui.click(ui.byText('button.tab', 'Automation'));

    const summary = ui.document.querySelector('#automation .device-meta') as HTMLElement;
    expect(summary.querySelector('svg.type-icon.clock')).not.toBeNull();
    expect(summary.textContent).toContain('22:00');
  });

  it('carries the clock in the activity log too, the way a press carries its device', async () => {
    const ui = await openInterface({
      state: { devices },
      rules: [],
      log: [
        {
          at: Date.now(),
          ruleId: 'r1',
          ruleName: 'Evening',
          ruleKind: 'standard',
          outcome: 'fired',
          detail: '1 action sent',
          firedAt: '22:00',
        },
      ],
    });
    await ui.click(ui.byText('button.tab', 'Activity'));

    const line = ui.document.querySelector('#activity-log .log-line') as HTMLElement;
    expect(line.querySelector('svg.type-icon.clock')).not.toBeNull();
    expect(line.textContent).toContain('22:00');
  });
});

describe('the rules that cannot be set off by a time', () => {
  const timer = {
    id: 't1',
    kind: 'timer',
    name: 'Hall',
    enabled: true,
    triggers: [{ ...ref('0xb'), match: { kind: 'changedTo', value: 'ON' } }],
    waitMs: 30_000,
    actions: [{ ...ref('0xa'), value: 'OFF' }],
  };

  it('offers no Time in a timer', async () => {
    const ui = await openRule(timer, 'Timers');
    expect(pickerOptions(ui, '#timers')).not.toContain('Time');
  });
});
