import { describe, expect, it } from 'vitest';

import { openInterface } from './helpers/interface.js';

const occupancy = {
  key: 'occupancy',
  label: 'Occupancy',
  semantic: 'occupancy',
  type: 'binary',
  category: 'primary',
  endpoint: '',
  readable: true,
  writable: false,
  publishable: true,
  role: 'motion',
  onValue: true,
  offValue: false,
};

const device = (deviceId: string, name: string, over: Record<string, unknown> = {}) => ({
  sourceId: 'zigbee',
  deviceId,
  name,
  topic: `zigbee2mqtt/${name}`,
  manufacturer: 'SONOFF',
  model: 'SNZB-06P',
  rulesOnly: false,
  renameable: false,
  endpoints: [''],
  properties: [occupancy],
  exposure: { properties: ['occupancy'] },
  state: {},
  lastSeen: {},
  ...over,
});

async function open(devices: unknown[]) {
  const ui = await openInterface({ state: { devices } });
  const card = ui.document.querySelector('#devices .device') as HTMLDetailsElement;
  await ui.openCard(card);
  return { ui, card };
}

describe('choosing what an occupancy reading becomes in HomeKit', () => {
  it('offers Motion or Occupancy, starting at Motion', async () => {
    const { card } = await open([device('0xa', 'study_presence')]);
    const select = card.querySelector('select.sensor-type') as HTMLSelectElement;

    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Motion sensor',
      'Occupancy sensor',
    ]);
    expect(select.value).toBe('Motion');
    expect(card.querySelector('.option label')?.textContent).toBe('HomeKit sensor');
  });

  it('saves Occupancy, and the tag beside the reading follows it', async () => {
    const { ui, card } = await open([device('0xa', 'study_presence')]);
    const tag = () => card.querySelector('[data-role-tag]')?.textContent;
    expect(tag()).toBe('motion sensor');

    const select = card.querySelector('select.sensor-type') as HTMLSelectElement;
    select.value = 'Occupancy';
    select.dispatchEvent(new ui.window.Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await ui.settle();

    expect(tag()).toBe('occupancy sensor');
    const saved = ui.requests.findLast((request) => request.path === '/api/exposure')?.body as {
      exposure: { sensorTypes?: Record<string, string> };
    };
    expect(saved.exposure.sensorTypes).toEqual({ occupancy: 'Occupancy' });
  });

  it('reads a stored choice back', async () => {
    const { card } = await open([
      device('0xa', 'study_presence', {
        exposure: { properties: ['occupancy'], sensorTypes: { occupancy: 'Occupancy' } },
      }),
    ]);
    expect((card.querySelector('select.sensor-type') as HTMLSelectElement).value).toBe('Occupancy');
    expect(card.querySelector('[data-role-tag]')?.textContent).toBe('occupancy sensor');
  });

  it('is not offered where there is nothing to choose, or nothing reaches HomeKit', async () => {
    const plain = await open([
      device('0xb', 'hall_lamp', {
        properties: [{ ...occupancy, key: 'state', semantic: 'state', role: 'power', writable: true }],
      }),
    ]);
    expect(plain.card.querySelector('select.sensor-type')).toBeNull();

    const rulesOnly = await open([device('0xc', 'study_presence', { rulesOnly: true })]);
    expect(rulesOnly.card.querySelector('select.sensor-type')).toBeNull();
  });
});
