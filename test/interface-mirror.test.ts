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

const devices = [device('0xa', 'lamp_a'), device('0xb', 'lamp_b'), device('0xc', 'lamp_c')];
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
  card.open = true;
  card.dispatchEvent(new ui.window.Event('toggle'));
  await ui.settle();
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
