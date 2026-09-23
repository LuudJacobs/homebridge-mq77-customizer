import { describe, expect, it } from 'vitest';

import { openInterface } from './helpers/interface.js';

const property = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  label: key,
  semantic: key,
  type: 'numeric',
  category: 'diagnostic',
  endpoint: '',
  readable: true,
  writable: false,
  publishable: true,
  ...over,
});

const device = (deviceId: string, name: string, keys: string[], state: Record<string, unknown>) => ({
  sourceId: 'zigbee',
  deviceId,
  name,
  topic: `zigbee2mqtt/${name}`,
  manufacturer: 'Aqara',
  model: 'X',
  rulesOnly: false,
  renameable: false,
  endpoints: [''],
  properties: keys.map((key) =>
    key === 'battery' ? property(key, { unit: '%' }) : property(key, { type: 'binary' }),
  ),
  exposure: { properties: [], type: 'sensor' },
  state,
  lastSeen: {},
});

const devices = [
  device('0xa', 'counted', ['battery'], { battery: 7 }),
  device('0xb', 'flagged', ['battery_low'], { battery_low: true }),
  device('0xc', 'fine', ['battery'], { battery: 80 }),
  device('0xd', 'mains', ['state'], {}),
];

const cardOf = (ui: { document: Document }, name: string) =>
  [...ui.document.querySelectorAll('#devices .device')].find(
    (card) => card.querySelector('.device-name')?.textContent === name,
  ) as HTMLDetailsElement;

const battery = (card: Element) => card.querySelector('summary svg.battery-low');

describe('a low battery in the device list', () => {
  it('shows a red battery on a device that counts below ten, and one that says so', async () => {
    const ui = await openInterface({ state: { devices } });

    expect(battery(cardOf(ui, 'counted'))).not.toBeNull();
    expect(battery(cardOf(ui, 'flagged'))).not.toBeNull();
    expect(battery(cardOf(ui, 'fine'))).toBeNull();
    expect(battery(cardOf(ui, 'mains'))).toBeNull();
  });

  it('puts it first in the bar, before the kind', async () => {
    const ui = await openInterface({ state: { devices } });
    const icons = cardOf(ui, 'counted').querySelector('summary .device-icons') as HTMLElement;
    const drawn = [...icons.querySelectorAll('svg')].map((svg) => svg.getAttribute('class'));
    expect(drawn).toEqual(['type-icon battery-low', 'type-icon sensor']);
    // And the icons are the first thing in the bar.
    expect(cardOf(ui, 'counted').querySelector('summary')?.firstElementChild).toBe(icons);
  });

  it('says how low, where the device counts it', async () => {
    const ui = await openInterface({ state: { devices } });
    expect(battery(cardOf(ui, 'counted'))?.querySelector('title')?.textContent).toBe(
      'Battery low (7%)',
    );
    expect(battery(cardOf(ui, 'flagged'))?.querySelector('title')?.textContent).toBe('Battery low');
  });

  it('comes and goes as readings arrive', async () => {
    const ui = await openInterface({ state: { devices } });

    await ui.live({ type: 'state', sourceId: 'zigbee', deviceId: '0xc', changes: { battery: 9 } });
    expect(battery(cardOf(ui, 'fine'))).not.toBeNull();

    // A new battery.
    await ui.live({ type: 'state', sourceId: 'zigbee', deviceId: '0xa', changes: { battery: 100 } });
    expect(battery(cardOf(ui, 'counted'))).toBeNull();
  });
});

describe('the low battery warning setting', () => {
  it('is offered after the diagnostics, with a topic set and a battery to watch', async () => {
    const ui = await openInterface({ state: { devices, canNotify: true } });
    const card = cardOf(ui, 'counted');
    await ui.openCard(card);

    const titles = [...card.querySelectorAll('.group-title')].map((node) => node.textContent);
    expect(titles.at(-1)).toBe('Low battery warning');
    expect(titles.indexOf('Diagnostics')).toBe(titles.length - 2);

    const box = card.querySelector('.battery-warning input[type="checkbox"]') as HTMLInputElement;
    // On unless somebody turned it off.
    expect(box.checked).toBe(true);
    expect(card.querySelector('.battery-warning label')?.textContent).toBe(
      'Send notification when battery runs low',
    );
  });

  it('is not offered without a topic, or on a device with no battery', async () => {
    const without = await openInterface({ state: { devices } });
    await without.openCard(cardOf(without, 'counted'));
    expect(cardOf(without, 'counted').querySelector('.battery-warning')).toBeNull();

    const mains = await openInterface({ state: { devices, canNotify: true } });
    await mains.openCard(cardOf(mains, 'mains'));
    expect(cardOf(mains, 'mains').querySelector('.battery-warning')).toBeNull();
  });

  it('saves turning it off, and nothing when it is on', async () => {
    const ui = await openInterface({ state: { devices, canNotify: true } });
    const card = cardOf(ui, 'counted');
    await ui.openCard(card);
    const box = card.querySelector('.battery-warning input') as HTMLInputElement;

    box.checked = false;
    box.dispatchEvent(new ui.window.Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await ui.settle();

    const saved = ui.requests.findLast((request) => request.path === '/api/exposure')?.body as {
      exposure: { batteryWarning?: boolean };
    };
    expect(saved.exposure.batteryWarning).toBe(false);
  });
});
