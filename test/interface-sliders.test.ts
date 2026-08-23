import { describe, expect, it } from 'vitest';

import { openInterface } from './helpers/interface.js';

const numeric = (key: string, label: string, max: number) => ({
  key,
  label,
  semantic: key,
  type: 'numeric',
  category: 'primary',
  endpoint: '',
  readable: true,
  writable: true,
  publishable: true,
  role: key === 'brightness' ? 'brightness' : 'rotationSpeed',
  min: 0,
  max,
});

const power = {
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

const action = {
  key: 'action',
  label: 'Action',
  semantic: 'action',
  type: 'enum',
  category: 'primary',
  endpoint: '',
  readable: true,
  writable: false,
  publishable: false,
  values: ['single_left', 'single_right'],
};

const device = (deviceId: string, name: string, properties: unknown[]) => ({
  sourceId: 'zigbee',
  deviceId,
  name,
  topic: `zigbee2mqtt/${name}`,
  manufacturer: 'Candeo',
  model: 'C202',
  rulesOnly: false,
  renameable: false,
  endpoints: [''],
  properties,
  exposure: { properties: [] },
  state: {},
  lastSeen: {},
});

const devices = [
  device('0xd1', 'hall_dimmer', [power, numeric('brightness', 'Brightness', 254)]),
  device('0xr1', 'rocker', [action]),
];

const slider = (overrides: Record<string, unknown> = {}) => ({
  id: 's1',
  kind: 'slider',
  name: 'Hall dimmer',
  enabled: true,
  target: { sourceId: 'zigbee', deviceId: '0xd1', propertyKey: 'brightness' },
  power: { sourceId: 'zigbee', deviceId: '0xd1', propertyKey: 'state' },
  steps: 4,
  up: { sourceId: 'zigbee', deviceId: '0xr1', propertyKey: 'action', match: { kind: 'changedTo', value: 'single_left' } },
  ...overrides,
});

async function openSliders(rules: unknown[] = [slider()]) {
  const ui = await openInterface({ state: { devices }, rules });
  await ui.click(ui.byText('button.tab', 'Sliders'));
  const card = ui.document.querySelector('#sliders .rule') as HTMLDetailsElement | null;
  if (card) {
    card.open = true;
    card.dispatchEvent(new ui.window.Event('toggle'));
    await ui.settle();
  }
  return ui;
}

describe('the sliders tab', () => {
  it('lists sliders, and nothing else does', async () => {
    const automation = {
      id: 'r1',
      name: 'An automation',
      enabled: true,
      triggers: [{ sourceId: 'zigbee', deviceId: '0xr1', propertyKey: 'action', match: { kind: 'changedTo', value: 'single_left' } }],
      branches: [{ actions: [{ sourceId: 'zigbee', deviceId: '0xd1', propertyKey: 'state', value: 'ON' }] }],
    };
    const ui = await openSliders([slider(), automation]);

    expect(ui.document.querySelectorAll('#sliders .rule')).toHaveLength(1);
    expect(ui.document.querySelector('#sliders .device-name')?.textContent).toBe('Hall dimmer');
  });

  it('says what a slider drives, and how far', async () => {
    const ui = await openSliders();
    const summary = ui.document.querySelector('#sliders .device-meta')?.textContent;
    expect(summary).toContain('Brightness');
    expect(summary).toContain('4 steps');
    expect(summary).toContain('1 button');
  });

  it('offers only levels a device will take', async () => {
    const ui = await openSliders();
    const level = ui.document.querySelector('#sliders .rule-row select.device-picker') as HTMLSelectElement;
    const offered = [...level.options].map((option) => option.textContent);

    // The rocker has nothing to drive, so it is not worth offering.
    expect(offered).toEqual(['hall_dimmer']);
  });

  it('works out the size of a step, and says so', async () => {
    const ui = await openSliders();
    const hints = [...ui.document.querySelectorAll('#sliders .hint')].map((node) => node.textContent);
    expect(hints.some((text) => text?.includes('4 steps of about 64'))).toBe(true);
  });

  it('follows the step count as it is changed', async () => {
    const ui = await openSliders();
    const steps = ui.document.querySelector('#sliders input.delay') as HTMLInputElement;
    steps.value = '2';
    steps.dispatchEvent(new ui.window.Event('input'));
    await ui.settle();

    const hints = [...ui.document.querySelectorAll('#sliders .hint')].map((node) => node.textContent);
    expect(hints.some((text) => text?.includes('2 steps of about 127'))).toBe(true);
  });

  it('starts a button that is not set with something to set it', async () => {
    const ui = await openSliders();
    const rows = () => ui.document.querySelectorAll('#sliders .rule-row').length;
    expect(rows()).toBe(2); // the level, and the one button that is set

    // The first one is on Dimmer, which has nothing yet.
    await ui.click(ui.byText('button.add-row', '+ trigger', '#sliders'));
    expect(rows()).toBe(3);
  });

  it('takes several triggers on one button, joined with or', async () => {
    const ui = await openSliders();
    const upRow = ui.document.querySelectorAll('#sliders .rule-row')[1]!;
    const another = [...upRow.querySelectorAll('button.add-row')].find(
      (node) => node.textContent === '+ trigger',
    )!;

    // One slider, several remotes.
    await ui.click(another);
    expect(ui.byText('span.joiner', 'or', '#sliders')).not.toBeNull();

    // Saving reloads the list, so the check above has to come first.
    await ui.click(ui.byText('button.primary', 'Save', '#sliders'));
    const saved = ui.requests.findLast((request) => request.body !== undefined)?.body as {
      up: unknown[];
    };
    expect(saved.up).toHaveLength(2);
  });

  it('takes a button off again', async () => {
    const ui = await openSliders();
    const before = ui.document.querySelectorAll('#sliders .rule-row').length;

    const remove = [...ui.document.querySelectorAll('#sliders button.add-row')].find(
      (node) => node.textContent === '✕',
    )!;
    await ui.click(remove);

    expect(ui.document.querySelectorAll('#sliders .rule-row').length).toBe(before - 1);
  });

  it('sends the whole slider when saved', async () => {
    const ui = await openSliders();
    await ui.click(ui.byText('button.primary', 'Save', '#sliders'));

    const saved = ui.requests.findLast((request) => request.body !== undefined)?.body as {
      kind: string;
      steps: number;
      target: { propertyKey: string };
      power: { propertyKey: string };
      up: { match: { value: string } }[];
    };
    expect(saved.kind).toBe('slider');
    expect(saved.steps).toBe(4);
    expect(saved.target.propertyKey).toBe('brightness');
    // The switch is worked out from the device rather than asked for.
    expect(saved.power.propertyKey).toBe('state');
    // Buttons are lists now, so one slider can take several remotes.
    expect(saved.up[0]!.match.value).toBe('single_left');
  });

  it('adds one from the tab, off to begin with', async () => {
    const ui = await openInterface({ state: { devices }, rules: [] });
    await ui.click(ui.byText('button.tab', 'Sliders'));
    await ui.click(ui.byText('button', 'Add slider'));

    const created = ui.requests.find((request) => request.body !== undefined)?.body as {
      kind: string;
      enabled: boolean;
    };
    expect(created.kind).toBe('slider');
    // Half built rules must not fire while they are being filled in.
    expect(created.enabled).toBe(false);
  });

  it('says when a device has no switch for the ends of the range', async () => {
    const fanOnly = device('0xf1', 'shed_fan', [numeric('speed', 'Speed', 100)]);
    const ui = await openInterface({
      state: { devices: [...devices, fanOnly] },
      rules: [
        slider({
          target: { sourceId: 'zigbee', deviceId: '0xf1', propertyKey: 'speed' },
          power: undefined,
        }),
      ],
    });
    await ui.click(ui.byText('button.tab', 'Sliders'));
    const card = ui.document.querySelector('#sliders .rule') as HTMLDetailsElement;
    card.open = true;
    card.dispatchEvent(new ui.window.Event('toggle'));
    await ui.settle();

    const hints = [...ui.document.querySelectorAll('#sliders .hint')].map((node) => node.textContent);
    expect(hints.some((text) => text?.includes('cannot'))).toBe(true);
  });

  it('offers sliders in the activity filter', async () => {
    const ui = await openInterface({ state: { devices }, rules: [slider()] });
    await ui.click(ui.byText('button.tab', 'Activity'));
    expect(ui.document.querySelector('#kind-slider')).not.toBeNull();
  });
});
