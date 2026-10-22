import { describe, expect, it } from 'vitest';

import { openInterface } from './helpers/interface.js';

const device = (deviceId: string, name: string, exposure: Record<string, unknown>) => ({
  sourceId: 'zigbee',
  deviceId,
  name,
  topic: `zigbee2mqtt/${name}`,
  manufacturer: 'IKEA',
  model: 'E1743',
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

const devices = () => [
  device('0xa', 'hall_motion', { room: 'Gang', label: 'Beweging', type: 'sensor' }),
  device('0xb', 'study_lamp', { room: 'Kantoor', label: 'Lamp', type: 'light' }),
  // No name of its own, so the line says its Zigbee2MQTT name and not its room.
  device('0xc', 'attic_switch', { room: 'Zolder', type: 'controller' }),
];
const ref = (deviceId: string) => ({ sourceId: 'zigbee', deviceId, propertyKey: 'state' });

const rules = [
  {
    id: 'r1',
    name: 'Licht aan',
    enabled: true,
    triggers: [{ ...ref('0xa'), match: { kind: 'changedTo', value: 'ON' } }],
    branches: [{ actions: [{ ...ref('0xb'), value: 'ON' }] }],
  },
];

const log = [
  {
    at: Date.now() - 1000,
    ruleId: 'r1',
    ruleName: 'Licht aan',
    ruleKind: 'standard',
    outcome: 'fired',
    detail: '1 action sent',
    changed: { ...ref('0xa'), value: 'ON' },
  },
  {
    at: Date.now() - 1500,
    ruleId: 'zigbee:0xc',
    ruleName: 'attic_switch',
    ruleKind: 'action',
    outcome: 'fired',
    detail: 'State ON',
    press: { ...ref('0xc'), value: 'ON' },
  },
  {
    at: Date.now() - 2000,
    ruleId: 'r9',
    ruleName: 'Iets anders',
    ruleKind: 'standard',
    outcome: 'conditionsFailed',
    detail: 'no',
  },
];

async function filtered(term: string) {
  const ui = await openInterface({ state: { devices: devices() }, rules, log });
  await ui.click(ui.byText('button.tab', 'Log'));
  // Presses on a line of their own are hidden to begin with.
  const presses = ui.document.getElementById('kind-action') as HTMLInputElement;
  presses.checked = true;
  presses.dispatchEvent(new ui.window.Event('change'));
  const filter = ui.document.querySelector('#filter') as HTMLInputElement;
  filter.value = term;
  filter.dispatchEvent(new ui.window.Event('input'));
  await ui.settle();
  return ui.document.querySelectorAll('#activity-log .log-line').length;
}

describe('filtering the log', () => {
  it('finds a line by what it says', async () => {
    // The device as it is named here, and how the rule ended.
    expect(await filtered('gang beweging')).toBe(1);
    expect(await filtered('conditions not met')).toBe(1);
    expect(await filtered('licht aan')).toBe(1);
  });

  it('finds a line by the name and topic of a device in it, said or not', async () => {
    expect(await filtered('hall_motion')).toBe(1);
    expect(await filtered('zigbee2mqtt/study_lamp')).toBe(1);
  });

  it('finds a line by the room of a device in it, said or not', async () => {
    // The switch is in Zolder, which its line does not say.
    expect(await filtered('zolder')).toBe(1);
  });

  it('finds nothing for what no line has', async () => {
    expect(await filtered('kelder')).toBe(0);
  });
});
