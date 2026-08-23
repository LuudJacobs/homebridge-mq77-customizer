import { describe, expect, it } from 'vitest';

import { openInterface } from './helpers/interface.js';

const device = (deviceId: string, name: string, exposure: Record<string, unknown> = {}) => ({
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
  exposure: { properties: [], ...exposure },
  state: {},
  lastSeen: {},
});

const devices = [device('0xa', 'hall_lamp'), device('0xb', 'porch_lamp', { room: 'Porch' })];

const ref = (deviceId: string) => ({ sourceId: 'zigbee', deviceId, propertyKey: 'state' });

const timer = (overrides: Record<string, unknown> = {}) => ({
  id: 't1',
  kind: 'timer',
  name: 'Light out',
  enabled: true,
  triggers: [{ ...ref('0xa'), match: { kind: 'changedTo', value: 'ON' } }],
  waitMs: 90_000,
  actions: [{ ...ref('0xb'), value: 'OFF' }],
  ...overrides,
});

async function openTimers(rules: unknown[] = [timer()]) {
  const ui = await openInterface({ state: { devices }, rules });
  await ui.click(ui.byText('button.tab', 'Timers'));
  const card = ui.document.querySelector('#timers .rule') as HTMLDetailsElement | null;
  if (card) {
    card.open = true;
    card.dispatchEvent(new ui.window.Event('toggle'));
    await ui.settle();
  }
  return ui;
}

describe('the timers tab', () => {
  it('lists timers, and nothing else does', async () => {
    const automation = {
      id: 'r1',
      name: 'An automation',
      enabled: true,
      triggers: [{ ...ref('0xa'), match: { kind: 'changedTo', value: 'ON' } }],
      branches: [{ actions: [{ ...ref('0xb'), value: 'ON' }] }],
    };
    const ui = await openTimers([timer(), automation]);

    expect(ui.document.querySelectorAll('#timers .rule')).toHaveLength(1);
    expect(ui.document.querySelectorAll('#automation .rule')).toHaveLength(1);
  });

  it('describes itself like an automation, with the wait in the middle', async () => {
    const ui = await openTimers();
    const meta = ui.document.querySelector('#timers .device-meta')?.textContent;
    // A room alone does not change a name, so both read as the source names.
    expect(meta).toBe('hall_lamp → 1m 30s → porch_lamp');
  });

  it('is named by the room it acts in', async () => {
    const ui = await openTimers();
    expect(ui.document.querySelector('#timers .device-name')?.textContent).toBe(
      'Porch: Light out',
    );
  });

  it('splits the wait into minutes and seconds', async () => {
    const ui = await openTimers();
    // The action row has a delay box of its own, so ask the wait row only.
    const boxes = [
      ...ui.document.querySelectorAll('#timers .option input.delay'),
    ] as HTMLInputElement[];
    expect(boxes.map((box) => box.value)).toEqual(['1', '30']);
  });

  it('sends the wait in milliseconds when saved', async () => {
    const ui = await openTimers();
    const [minutes, seconds] = [
      ...ui.document.querySelectorAll('#timers .option input.delay'),
    ] as HTMLInputElement[];

    minutes!.value = '2';
    minutes!.dispatchEvent(new ui.window.Event('input'));
    seconds!.value = '5';
    seconds!.dispatchEvent(new ui.window.Event('input'));
    await ui.settle();

    await ui.click(ui.byText('button.primary', 'Save', '#timers'));
    const saved = ui.requests.findLast((request) => request.body !== undefined)?.body as {
      kind: string;
      waitMs: number;
    };
    expect(saved.kind).toBe('timer');
    expect(saved.waitMs).toBe(125_000);
  });

  it('never sends a wait of nothing', async () => {
    const ui = await openTimers();
    const [minutes, seconds] = [
      ...ui.document.querySelectorAll('#timers .option input.delay'),
    ] as HTMLInputElement[];

    minutes!.value = '0';
    minutes!.dispatchEvent(new ui.window.Event('input'));
    seconds!.value = '0';
    seconds!.dispatchEvent(new ui.window.Event('input'));
    await ui.settle();

    await ui.click(ui.byText('button.primary', 'Save', '#timers'));
    const saved = ui.requests.findLast((request) => request.body !== undefined)?.body as {
      waitMs: number;
    };
    // A timer of nothing is an automation, and there is a tab for those.
    expect(saved.waitMs).toBeGreaterThan(0);
  });

  it('adds one from the tab, off to begin with', async () => {
    const ui = await openInterface({ state: { devices }, rules: [] });
    await ui.click(ui.byText('button.tab', 'Timers'));
    await ui.click(ui.byText('button', 'Add timer'));

    const created = ui.requests.find((request) => request.body !== undefined)?.body as {
      kind: string;
      enabled: boolean;
    };
    expect(created.kind).toBe('timer');
    expect(created.enabled).toBe(false);
  });

  it('offers name, room and trigger device as sorts', async () => {
    const ui = await openTimers();
    const options = [...ui.document.querySelectorAll('#sort option')].map(
      (node) => (node as HTMLOptionElement).value,
    );
    expect(options).toEqual(['name', 'room', 'trigger']);
  });

  it('groups under the device that starts it', async () => {
    const ui = await openTimers();
    const sort = ui.document.querySelector('#sort') as HTMLSelectElement;
    sort.value = 'trigger';
    sort.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();

    const headings = [...ui.document.querySelectorAll('#timers .rule-group')].map(
      (node) => node.textContent,
    );
    expect(headings).toEqual(['hall_lamp']);
  });

  it('offers timers in the activity filter', async () => {
    const ui = await openInterface({ state: { devices }, rules: [timer()] });
    await ui.click(ui.byText('button.tab', 'Activity'));
    expect(ui.document.querySelector('#kind-timer')).not.toBeNull();
  });
});
