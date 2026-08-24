import { describe, expect, it } from 'vitest';

import { openInterface } from './helpers/interface.js';

const property = (over: Record<string, unknown> = {}) => ({
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
  ...over,
});

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
  properties: [property()],
  exposure: { properties: [] },
  state: {},
  lastSeen: {},
});

/** Three channels of the same switch, all of them writable. */
const threeGang = {
  ...device('0xd', 'switch_d'),
  endpoints: ['l1', 'l2', 'l3'],
  properties: ['l1', 'l2', 'l3'].map((endpoint) =>
    property({ key: `state_${endpoint}`, endpoint, label: 'State' }),
  ),
};

const devices = [
  device('0xa', 'lamp_a'),
  device('0xb', 'lamp_b'),
  device('0xc', 'lamp_c'),
  threeGang,
];
const ref = (deviceId: string) => ({ sourceId: 'zigbee', deviceId, propertyKey: 'state' });

const pair = {
  id: 'm1',
  kind: 'mirror',
  name: 'Together',
  enabled: true,
  groups: [[ref('0xa'), ref('0xb')]],
};

async function openMirror(rules: unknown[] = [pair]) {
  const ui = await openInterface({ state: { devices }, rules });
  await ui.click(ui.byText('button.tab', 'Mirror devices'));
  const card = ui.document.querySelector('#mirror .rule') as HTMLDetailsElement;
  await ui.openCard(card);
  return ui;
}

const deviceBoxes = (ui: { document: Document }) =>
  [...ui.document.querySelectorAll('#mirror .mirror-devices input')] as HTMLInputElement[];

async function tick(
  ui: Awaited<ReturnType<typeof openMirror>>,
  box: HTMLInputElement,
  on: boolean,
) {
  box.checked = on;
  box.dispatchEvent(new ui.window.Event('change'));
  await ui.settle();
}

async function saved(ui: Awaited<ReturnType<typeof openMirror>>) {
  await ui.click(ui.byText('button.primary', 'Save', '#mirror'));
  return ui.requests.findLast((request) => request.body !== undefined)?.body as {
    groups: { deviceId: string }[][];
  };
}

describe('changing which devices a mirror covers', () => {
  it('adds a device to the group it is already mirroring', async () => {
    const ui = await openMirror();
    const boxes = deviceBoxes(ui);
    expect(boxes.filter((box) => box.checked)).toHaveLength(2);

    await tick(ui, boxes.find((box) => !box.checked)!, true);

    // Adding a device redraws the rows. Without writing them back the group
    // kept the pair it had, and the third device was dropped on save.
    const body = await saved(ui);
    expect(body.groups[0]?.map((member) => member.deviceId).sort()).toEqual(['0xa', '0xb', '0xc']);
  });

  it('drops a group left with one device rather than saving a broken one', async () => {
    const ui = await openMirror();
    const boxes = deviceBoxes(ui);

    await tick(ui, boxes.find((box) => box.checked)!, false);

    // One device mirrors nothing. Keeping it only meant the save was refused
    // later for a reason nobody could see on the screen.
    const body = await saved(ui);
    expect(body.groups).toEqual([]);
  });

  it('keeps the rest of the group when one of three is removed', async () => {
    const three = { ...pair, groups: [[ref('0xa'), ref('0xb'), ref('0xc')]] };
    const ui = await openMirror([three]);
    const boxes = deviceBoxes(ui);

    await tick(ui, boxes[2]!, false);

    const body = await saved(ui);
    expect(body.groups[0]?.map((member) => member.deviceId).sort()).toEqual(['0xa', '0xb']);
  });

  it('mirrors every channel of a device that carries the same function three times', async () => {
    const ui = await openMirror([{ ...pair, groups: [[ref('0xa'), ref('0xb')]] }]);
    await tick(ui, deviceBoxes(ui)[3]!, true);

    const ticks = [
      ...ui.document.querySelectorAll('#mirror .mirror-pick input'),
    ] as HTMLInputElement[];
    expect(ticks).toHaveLength(3);

    // One channel to begin with, and the other two are there to be added.
    expect(ticks.filter((box) => box.checked)).toHaveLength(1);
    await tick(ui, ticks[1]!, true);
    await tick(ui, ticks[2]!, true);

    const body = await saved(ui);
    expect(body.groups[0]?.map((member) => member.propertyKey)).toEqual([
      'state',
      'state',
      'state_l1',
      'state_l2',
      'state_l3',
    ]);
  });

  it('holds the last channel of a device, which is why it is in the group', async () => {
    const ui = await openMirror([{ ...pair, groups: [[ref('0xa'), ref('0xb')]] }]);
    await tick(ui, deviceBoxes(ui)[3]!, true);

    const ticks = [
      ...ui.document.querySelectorAll('#mirror .mirror-pick input'),
    ] as HTMLInputElement[];
    expect(ticks[0]!.disabled).toBe(true);

    // With two of them in, either may go.
    await tick(ui, ticks[1]!, true);
    expect(ticks.map((box) => box.disabled)).toEqual([false, false, false]);
  });

  it('builds one from nothing', async () => {
    const blank = { id: 'm1', kind: 'mirror', name: 'New mirror', enabled: false, groups: [] };
    const ui = await openMirror([blank]);
    const boxes = deviceBoxes(ui);

    await tick(ui, boxes[0]!, true);
    await tick(ui, boxes[1]!, true);

    const field = ui.document.querySelector(
      '#mirror .rule-row input[type=checkbox]',
    ) as HTMLInputElement;
    await tick(ui, field, true);

    const body = await saved(ui);
    expect(body.groups[0]).toHaveLength(2);
  });
});
