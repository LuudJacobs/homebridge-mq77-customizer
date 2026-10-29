import { describe, expect, it } from 'vitest';

import { openInterface } from './helpers/interface.js';

const property = (key: string) => ({
  key,
  label: key,
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

const device = (deviceId: string, label: string, exposed: string[], rulesOnly = false) => ({
  sourceId: 'zigbee',
  deviceId,
  name: `device_${deviceId}`,
  topic: `zigbee2mqtt/device_${deviceId}`,
  manufacturer: 'SONOFF',
  model: 'ZBMINIL2',
  rulesOnly,
  renameable: false,
  endpoints: [''],
  properties: [property('state_l1'), property('state_l2')],
  exposure: { properties: exposed, label, type: 'light' },
  state: {},
  lastSeen: {},
});

describe('the label on a device', () => {
  it('says how many reach HomeKit, and nothing for one that reaches none', async () => {
    const ui = await openInterface({
      state: {
        devices: [
          device('0xa', 'Beide', ['state_l1', 'state_l2']),
          device('0xb', 'Geen', []),
          device('0xc', 'Regels', ['state_l1'], true),
        ],
      },
    });
    const badges = Object.fromEntries(
      [...ui.document.querySelectorAll('#devices .device')].map((card) => {
        const badge = card.querySelector('summary .badge') as HTMLElement;
        return [card.querySelector('.device-name')?.textContent, badge.hidden ? null : badge.textContent];
      }),
    );
    expect(badges).toEqual({ Beide: '2 in HomeKit', Geen: null, Regels: null });
  });
});
