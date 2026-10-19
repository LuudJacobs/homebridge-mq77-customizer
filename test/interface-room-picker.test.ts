import { describe, expect, it } from 'vitest';

import { openInterface } from './helpers/interface.js';

const property = {
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
};

const device = (deviceId: string, name: string, room?: string) => ({
  sourceId: 'zigbee',
  deviceId,
  name,
  topic: `zigbee2mqtt/${name}`,
  manufacturer: 'SONOFF',
  model: 'ZBMINIL2',
  rulesOnly: false,
  renameable: false,
  endpoints: [''],
  properties: [property],
  exposure: { properties: [], ...(room ? { room } : {}) },
  state: {},
  lastSeen: {},
});

const devices = [
  device('0xa', 'plafond', 'Woonkamer'),
  device('0xb', 'lamp', 'Woonkamer'),
  device('0xc', 'spot', 'Keuken'),
  device('0xd', 'zolderlamp'),
];

const ref = (deviceId: string) => ({ sourceId: 'zigbee', deviceId, propertyKey: 'state' });

const rule = {
  id: 'r1',
  name: 'Avond',
  enabled: true,
  triggers: [{ ...ref('0xc'), match: { kind: 'changedTo', value: 'ON' } }],
  branches: [{ actions: [{ ...ref('0xa'), value: 'ON' }] }],
};

async function openRule() {
  const ui = await openInterface({ state: { devices }, rules: [rule] });
  await ui.click(ui.byText('button.tab', 'Automation'));
  await ui.openCard(ui.document.querySelector('.rule') as HTMLDetailsElement);
  return ui;
}

const pickers = (row: Element) => ({
  room: row.querySelector('.room-picker') as HTMLSelectElement,
  device: row.querySelector('.device-picker') as HTMLSelectElement,
});

const texts = (select: HTMLSelectElement) =>
  [...select.options].map((option) => option.textContent);

describe('picking a device by its room first', () => {
  it('lists the rooms by name, then the devices without one, then the clock', async () => {
    const ui = await openRule();
    const { room } = pickers(ui.document.querySelector('.triggers .rule-row')!);
    expect(texts(room)).toEqual(['Room', 'Keuken', 'Woonkamer', 'Unknown', 'Current time']);
    // The prompt is shown, never picked.
    expect(room.options[0]?.disabled).toBe(true);
  });

  it('opens a stored rule on its device’s room, with the device chosen', async () => {
    const ui = await openRule();
    const action = pickers(ui.document.querySelector('.actions .rule-row')!);

    expect(action.room.value).toBe('Woonkamer');
    expect(action.device.disabled).toBe(false);
    // The room has been said, so the devices are named without it.
    expect(texts(action.device)).toEqual(['lamp', 'plafond']);
    expect(action.device.value).toBe('zigbee|0xa');
  });

  it('offers only the devices in the room picked, and points at the first', async () => {
    const ui = await openRule();
    const action = pickers(ui.document.querySelector('.actions .rule-row')!);

    action.room.value = 'Keuken';
    action.room.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();

    expect(texts(action.device)).toEqual(['spot']);
    await ui.click(ui.byText('button.primary', 'Save', '#automation'));
    const saved = ui.requests.findLast((request) => request.body !== undefined)?.body as {
      branches: { actions: { deviceId: string }[] }[];
    };
    expect(saved.branches[0]?.actions[0]?.deviceId).toBe('0xc');
  });

  it('starts a row added to a rule with no room, and the device dropdown empty and off', async () => {
    const ui = await openRule();
    await ui.click(ui.byText('button.add-row', '+ action', '.actions'));

    const rows = ui.document.querySelectorAll('.actions .rule-row');
    const added = pickers(rows[rows.length - 1]!);
    expect(added.room.value).toBe('');
    expect(added.device.disabled).toBe(true);
    expect(added.device.options).toHaveLength(0);
  });

  it('shows nothing to set on an added row until a room is picked', async () => {
    const ui = await openRule();
    await ui.click(ui.byText('button.add-row', '+ action', '.actions'));

    const rows = ui.document.querySelectorAll('.actions .rule-row');
    const row = rows[rows.length - 1]!;
    const property = () => row.querySelectorAll(':scope > select')[2] as HTMLSelectElement;
    expect(property().disabled).toBe(true);
    // Only the buttons: no `set to`, no value, no delay.
    expect(row.querySelectorAll('.rule-tail select, .rule-tail input')).toHaveLength(0);
    expect([...row.querySelectorAll('.rule-tail button')].map((b) => b.textContent)).toEqual([
      '✕',
      '+ action',
    ]);

    const { room } = pickers(row);
    room.value = 'Keuken';
    room.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();

    expect(property().disabled).toBe(false);
    expect(row.querySelector('.rule-tail select')).not.toBeNull();
    expect(row.querySelector('.rule-tail input.delay')).not.toBeNull();
  });

  it('empties and turns off the device dropdown for the clock', async () => {
    const ui = await openRule();
    const trigger = pickers(ui.document.querySelector('.triggers .rule-row')!);

    trigger.room.value = '__time';
    trigger.room.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();

    const again = pickers(ui.document.querySelector('.triggers .rule-row')!);
    expect(again.room.value).toBe('__time');
    expect(again.device.disabled).toBe(true);
    expect(again.device.options).toHaveLength(0);
  });

  it('still gives a brand-new automation a device, so it can be stored at all', async () => {
    const ui = await openInterface({ state: { devices }, rules: [] });
    await ui.click(ui.byText('button.tab', 'Automation'));
    await ui.click(ui.byText('button', '+ automation'));

    const created = ui.requests.find((request) => request.body !== undefined)?.body as {
      trigger: { deviceId: string };
      actions: { deviceId: string }[];
    };
    expect(created.trigger.deviceId).not.toBe('');
    expect(created.actions[0]?.deviceId).not.toBe('');
  });
});
