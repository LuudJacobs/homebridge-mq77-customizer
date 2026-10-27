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
  exposure: { properties: [], type: 'light', ...exposure },
  state: {},
  lastSeen: {},
});

const devices = () => [
  device('0xa', 'a_lamp', { room: 'Gang' }),
  device('0xb', 'b_lamp', { room: 'Keuken' }),
];

const cardOf = (ui: { document: Document }, id: string) =>
  ui.document.querySelector(`#devices [data-name="zigbee:${id}"]`)!.closest('details') as HTMLDetailsElement;
const nameOf = (card: Element) => card.querySelector('.device-name')!.textContent;
const revertOf = (card: Element) =>
  [...card.querySelectorAll('.rule-footer button')].find((b) => b.textContent === 'Revert') as HTMLButtonElement;
const tick = (card: Element) => card.querySelector('input[type="checkbox"]') as HTMLInputElement;

async function open() {
  const ui = await openInterface({ state: { devices: devices() } });
  const card = cardOf(ui, '0xa');
  await ui.openCard(card);
  return { ui, card };
}

async function change(ui: Awaited<ReturnType<typeof openInterface>>, box: HTMLInputElement) {
  box.checked = !box.checked;
  box.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
  await ui.settle();
}

describe('a device panel', () => {
  it('keeps a change until Save, and marks the device meanwhile', async () => {
    const { ui, card } = await open();
    expect(nameOf(card)).toBe('a_lamp');
    expect(revertOf(card).hidden).toBe(true);

    await change(ui, tick(card));
    expect(ui.requests.some((request) => request.path === '/api/exposure')).toBe(false);
    expect(nameOf(cardOf(ui, '0xa'))).toBe('* a_lamp');
    expect(revertOf(cardOf(ui, '0xa')).hidden).toBe(false);

    await ui.click(cardOf(ui, '0xa').querySelector('.rule-footer button.primary'));
    const saved = ui.requests.findLast((request) => request.path === '/api/exposure')?.body as {
      exposure: { properties: string[] };
    };
    expect(saved.exposure.properties).toEqual(['state']);
    expect(nameOf(cardOf(ui, '0xa'))).toBe('a_lamp');
    expect(revertOf(cardOf(ui, '0xa')).hidden).toBe(true);
  });

  it('is marked as soon as its name or room is typed, without being redrawn', async () => {
    const { ui, card } = await open();
    const name = card.querySelector('.device-field input') as HTMLInputElement;
    const room = card.querySelector('.device-field select.room-select') as HTMLSelectElement;

    name.value = 'Lamp';
    name.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    expect(nameOf(card)).toBe('* a_lamp');
    expect(revertOf(card).hidden).toBe(false);

    name.value = '';
    name.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    expect(nameOf(card)).toBe('a_lamp');

    room.value = 'Kitchen';
    room.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
    expect(nameOf(card)).toBe('* a_lamp');
  });

  it('goes back to what is saved on Revert', async () => {
    const { ui, card } = await open();
    await change(ui, tick(card));
    await ui.click(revertOf(cardOf(ui, '0xa')));

    expect(tick(cardOf(ui, '0xa')).checked).toBe(false);
    expect(nameOf(cardOf(ui, '0xa'))).toBe('a_lamp');
    expect(revertOf(cardOf(ui, '0xa')).hidden).toBe(true);
  });

  it('is not marked once a change is undone by hand', async () => {
    const { ui, card } = await open();
    await change(ui, tick(card));
    await change(ui, tick(cardOf(ui, '0xa')));
    expect(nameOf(cardOf(ui, '0xa'))).toBe('a_lamp');
  });

  it('keeps what it holds through a tab switch and a live update', async () => {
    const { ui, card } = await open();
    await change(ui, tick(card));

    await ui.click(ui.byText('button.tab', 'Rules'));
    await ui.click(ui.byText('button.tab', 'Devices'));
    await ui.live({ type: 'devices' });

    expect(tick(cardOf(ui, '0xa')).checked).toBe(true);
    expect(nameOf(cardOf(ui, '0xa'))).toBe('* a_lamp');
  });

  it('moves in the list only once it is saved', async () => {
    const { ui, card } = await open();
    const sort = ui.document.querySelector('#sort') as HTMLSelectElement;
    sort.value = 'room';
    sort.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();

    const room = cardOf(ui, '0xa').querySelector('.device-field select.room-select') as HTMLSelectElement;
    room.value = 'Keuken';
    room.dispatchEvent(new ui.window.Event('change', { bubbles: true }));
    await ui.settle();
    const section = (id: string) =>
      cardOf(ui, id).closest('.section-items')!.previousElementSibling!.textContent;
    expect(section('0xa')).toBe('Gang (1)');
    expect(card).toBeDefined();

    await ui.click(cardOf(ui, '0xa').querySelector('.rule-footer button.primary'));
    expect(section('0xa')).toBe('Keuken (2)');
  });

  it('forgets the device on Delete, asked twice', async () => {
    const { ui, card } = await open();
    const remove = card.querySelector('.rule-footer button.danger') as HTMLButtonElement;
    await ui.click(remove);
    expect(ui.requests.some((request) => request.path === '/api/devices')).toBe(false);
    await ui.click(remove);
    expect(ui.requests.findLast((request) => request.path === '/api/devices')?.body).toEqual({
      sourceId: 'zigbee',
      deviceId: '0xa',
    });
  });
});

describe('a rule panel', () => {
  const rule = {
    id: 'r1',
    name: 'Licht',
    enabled: true,
    triggers: [{ sourceId: 'zigbee', deviceId: '0xa', propertyKey: 'state', match: { kind: 'changedTo', value: 'ON' } }],
    branches: [{ actions: [{ sourceId: 'zigbee', deviceId: '0xb', propertyKey: 'state', value: 'ON' }] }],
  };

  async function openRule() {
    const ui = await openInterface({ state: { devices: devices() }, rules: [rule] });
    await ui.click(ui.byText('button.tab', 'Rules'));
    await ui.openCard(ui.document.querySelector('#automation .rule') as HTMLDetailsElement);
    return ui;
  }
  const ruleName = (ui: { document: Document }) =>
    ui.document.querySelector('#automation .rule .device-name')!.textContent;
  const button = (ui: { document: Document }, text: string) =>
    [...ui.document.querySelectorAll('#automation .rule-footer button')].find(
      (node) => node.textContent === text,
    ) as HTMLButtonElement;
  const rename = async (ui: Awaited<ReturnType<typeof openRule>>, to: string) => {
    const input = ui.document.querySelector('#automation .rule .option input') as HTMLInputElement;
    input.value = to;
    input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await ui.settle();
  };

  it('marks the rule and offers Revert once something changes, and hides Trigger', async () => {
    const ui = await openRule();
    expect(button(ui, 'Revert').hidden).toBe(true);
    expect(button(ui, 'Trigger').hidden).toBe(false);

    await rename(ui, 'Lampen');
    expect(ruleName(ui)).toBe('* Whole house: Licht');
    expect(button(ui, 'Revert').hidden).toBe(false);
    expect(button(ui, 'Trigger').hidden).toBe(true);

    await ui.click(button(ui, 'Revert'));
    expect(ruleName(ui)).toBe('Whole house: Licht');
    expect((ui.document.querySelector('#automation .rule .option input') as HTMLInputElement).value).toBe('Licht');
  });

  it('keeps what was typed through a live reload of the rules', async () => {
    const ui = await openRule();
    await rename(ui, 'Lampen');
    await ui.live({ type: 'rules' });
    expect((ui.document.querySelector('#automation .rule .option input') as HTMLInputElement).value).toBe('Lampen');
  });

  it('saves with the switch as it is now, not as it was when editing began', async () => {
    const ui = await openRule();
    await rename(ui, 'Lampen');
    // Switched off in the header meanwhile, which saves on its own.
    ui.responses['/api/rules'] = { rules: [{ ...rule, enabled: false }] };
    await ui.live({ type: 'rules' });

    await ui.click(button(ui, 'Save'));
    const saved = ui.requests.findLast((request) => request.path === '/api/rules' && request.body)?.body as {
      name: string;
      enabled: boolean;
    };
    expect(saved).toMatchObject({ name: 'Lampen', enabled: false });
  });
});

describe('leaving the page', () => {
  it('is asked about only with something unsaved', async () => {
    const { ui, card } = await open();
    const leave = () => {
      const event = new ui.window.Event('beforeunload', { cancelable: true });
      ui.window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(leave()).toBe(false);
    await change(ui, tick(card));
    expect(leave()).toBe(true);
  });
});
