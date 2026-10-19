import { describe, expect, it } from 'vitest';

import { openInterface } from './helpers/interface.js';

const device = (deviceId: string, name: string, room: string) => ({
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
  exposure: { properties: [], room, type: 'light' },
  state: {},
  lastSeen: {},
});

const devices = () => [device('0xa', 'lamp_a', 'Gang'), device('0xb', 'lamp_b', 'Keuken')];
const ref = (deviceId: string) => ({ sourceId: 'zigbee', deviceId, propertyKey: 'state' });

const rule = (actions: unknown[]) => ({
  id: 'r1',
  name: 'Licht',
  enabled: true,
  triggers: [{ ...ref('0xa'), match: { kind: 'changedTo', value: 'ON' } }],
  branches: [{ actions }],
});

async function openRule(actions: unknown[], canNotify = true) {
  const ui = await openInterface({ state: { devices: devices(), canNotify }, rules: [rule(actions)] });
  await ui.click(ui.byText('button.tab', 'Automation'));
  await ui.openCard(ui.document.querySelector('.rule') as HTMLDetailsElement);
  return ui;
}

const rows = (ui: { document: Document }) => [...ui.document.querySelectorAll('.actions .rule-row')];
const roomOf = (row: Element) => row.querySelector('.room-picker') as HTMLSelectElement;
const texts = (select: HTMLSelectElement) => [...select.options].map((option) => option.textContent);

async function pick(ui: Awaited<ReturnType<typeof openRule>>, row: Element, value: string) {
  const room = roomOf(row);
  room.value = value;
  room.dispatchEvent(new ui.window.Event('change'));
  await ui.settle();
}

describe('ignoring as an action', () => {
  it('is the last choice in the first action row, and only there', async () => {
    const ui = await openRule([{ ...ref('0xb'), value: 'ON' }, { ...ref('0xa'), value: 'OFF' }]);
    const [first, second] = rows(ui);

    expect(texts(roomOf(first!)).at(-1)).toBe('Ignore');
    expect(texts(roomOf(second!))).not.toContain('Ignore');
    // Not something that sets a rule off, nor something it asks.
    expect(texts(roomOf(ui.document.querySelector('.triggers .rule-row')!))).not.toContain('Ignore');
  });

  it('is the whole row and the whole outcome once picked', async () => {
    const ui = await openRule([{ ...ref('0xb'), value: 'ON' }, { ...ref('0xa'), value: 'OFF' }]);
    await pick(ui, rows(ui)[0]!, '__ignore');

    expect(rows(ui)).toHaveLength(1);
    const row = rows(ui)[0]!;
    expect(roomOf(row).value).toBe('__ignore');
    // Nothing beside it: no device, no value, no delay, no way to add more.
    expect(row.querySelectorAll('select, input')).toHaveLength(1);
    expect(row.querySelectorAll('button')).toHaveLength(0);
    expect(ui.byText('button.add-row', '+ action', '.actions')).toBeNull();

    await ui.click(ui.byText('button.primary', 'Save', '#automation'));
    const saved = ui.requests.findLast((request) => request.body !== undefined)?.body as {
      branches: { actions: unknown[] }[];
    };
    expect(saved.branches[0]?.actions).toEqual([{ kind: 'ignore' }]);
  });

  it('opens as it was saved, and goes back to a device when a room is picked', async () => {
    const ui = await openRule([{ kind: 'ignore' }]);
    expect(roomOf(rows(ui)[0]!).value).toBe('__ignore');

    await pick(ui, rows(ui)[0]!, 'Keuken');
    const row = rows(ui)[0]!;
    expect((row.querySelector('.device-picker') as HTMLSelectElement).value).toBe('zigbee|0xb');
    expect(ui.byText('button.add-row', '+ action', '.actions')).not.toBeNull();
  });

  it('takes over from a notification', async () => {
    const ui = await openRule([{ kind: 'notify', message: 'Hallo' }]);
    await pick(ui, rows(ui)[0]!, '__ignore');
    expect(rows(ui)[0]!.querySelector('textarea')).toBeNull();
    expect(roomOf(rows(ui)[0]!).value).toBe('__ignore');
  });

  it('says so in the list, where a rule names what it reaches', async () => {
    const ui = await openInterface({
      state: { devices: devices() },
      rules: [rule([{ kind: 'ignore' }])],
    });
    await ui.click(ui.byText('button.tab', 'Automation'));
    const meta = ui.document.querySelector('#automation .device-meta')!;
    meta.querySelectorAll('title').forEach((title) => title.remove());
    expect(meta.textContent).toBe('lamp_a → ignore');
  });
});
