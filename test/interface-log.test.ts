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

const device = (
  deviceId: string,
  name: string,
  exposure: Record<string, unknown>,
  properties = [property()],
) => ({
  sourceId: 'zigbee',
  deviceId,
  name,
  topic: `zigbee2mqtt/${name}`,
  manufacturer: 'SONOFF',
  model: 'SNZB-01',
  rulesOnly: false,
  renameable: false,
  endpoints: [''],
  properties,
  exposure: { properties: [], ...exposure },
  state: {},
  lastSeen: {},
});

const devices = [
  device('0xr', 'remote', { label: 'Remote', room: 'Woonkamer', type: 'controller' }, [
    property({ key: 'action', label: 'Action', semantic: 'action', type: 'enum' }),
  ]),
  device('0xa', 'lamp_a', { label: 'Voor', room: 'Gang', type: 'light' }),
  device('0xb', 'lamp_b', { label: 'Achter', room: 'Gang', type: 'light' }),
  device('0xc', 'ceiling', { label: 'Ceiling', room: 'Keuken', type: 'light' }, [
    property({ key: 'brightness', label: 'Brightness', semantic: 'brightness', type: 'numeric' }),
  ]),
  device('0xw', 'lamp_w', { label: 'Licht', room: 'Woonkamer', type: 'light' }),
];

const ref = (deviceId: string, propertyKey = 'state') => ({
  sourceId: 'zigbee',
  deviceId,
  propertyKey,
});

// Named for the rooms they act in, which is where the titles come from.
const rules = [
  {
    id: 'r1',
    kind: 'standard',
    name: 'All Off',
    enabled: true,
    triggers: [{ ...ref('0xr', 'action'), match: { kind: 'equals', value: '4_single_long' } }],
    actions: [{ ...ref('0xw'), value: 'OFF' }],
  },
  { id: 'm1', kind: 'mirror', name: 'Lichten', enabled: true, groups: [[ref('0xa'), ref('0xb')]] },
  {
    id: 's1',
    kind: 'slider',
    name: 'Ceiling',
    enabled: true,
    target: ref('0xc', 'brightness'),
    steps: 6,
  },
  {
    id: 't1',
    kind: 'timer',
    name: 'Aanrecht',
    enabled: true,
    triggers: [{ ...ref('0xc', 'brightness'), match: { kind: 'equals', value: 1 } }],
    waitMs: 2000,
    actions: [{ ...ref('0xc', 'brightness'), value: 0 }],
  },
];

const press = { sourceId: 'zigbee', deviceId: '0xr', propertyKey: 'action', value: '4_single_long' };

const entry = (over: Record<string, unknown>) => ({
  at: 1_700_000_000_000,
  ruleId: 'r1',
  ruleName: 'All Off',
  ruleKind: 'standard',
  outcome: 'fired',
  detail: '2 actions sent',
  ...over,
});

async function lines(log: unknown[]) {
  const ui = await openInterface({ state: { devices }, rules, log });
  await ui.click(ui.byText('button.tab', 'Activity'));

  // Presses of their own are left out by default, and here the list itself is
  // what is under test.
  const box = ui.document.getElementById('kind-action') as HTMLInputElement;
  box.checked = true;
  box.dispatchEvent(new ui.window.Event('change'));
  await ui.settle();

  return [...ui.document.querySelectorAll('#activity-log .log-line .log-what')].map((node) => {
    // The icons carry a title for anybody listening rather than looking, which
    // is not part of what the line reads as.
    for (const icon of node.querySelectorAll('svg')) {
      icon.remove();
    }
    return node.textContent?.replace(/\s+/g, ' ').trim();
  });
}

describe('what a log line says', () => {
  it('puts the press that set a rule off on the rule line', async () => {
    expect(await lines([entry({ press })])).toEqual([
      'Woonkamer Remote 4 Single Long → Woonkamer: All Off - ran: 2 actions sent',
    ]);
  });

  it('names the branch that ran, in quotes', async () => {
    expect(await lines([entry({ press, branch: 'None' })])).toEqual([
      "Woonkamer Remote 4 Single Long → Woonkamer: All Off - 'None' ran: 2 actions sent",
    ]);
  });

  it('reads a press that set nothing off as the device and the button', async () => {
    const noted = entry({
      ruleId: 'zigbee:0xr',
      ruleName: 'remote',
      ruleKind: 'action',
      detail: 'Action 2_triple',
      press: { ...press, value: '2_triple' },
    });
    expect(await lines([noted])).toEqual(['Woonkamer Remote: 2 Triple']);
  });

  it('says which function a mirror read and which it wrote', async () => {
    const copied = entry({
      ruleId: 'm1',
      ruleName: 'Lichten',
      ruleKind: 'mirror',
      detail: 'State copied to State',
      copy: {
        from: { sourceId: 'zigbee', deviceId: '0xa', propertyKey: 'state' },
        to: [{ sourceId: 'zigbee', deviceId: '0xb', propertyKey: 'state' }],
      },
    });
    expect(await lines([copied])).toEqual([
      'Gang: Lichten - ran: Gang Voor State → Gang Achter State',
    ]);
  });

  it('says what a slider did, in steps or in what it wrote', async () => {
    const slid = (step: Record<string, unknown>, outcome = 'fired') =>
      entry({ ruleId: 's1', ruleName: 'Ceiling', ruleKind: 'slider', outcome, step, detail: '' });

    expect(
      await lines([
        slid({ label: 'Brightness', direction: 'up', step: 1, steps: 6 }),
        slid({ label: 'Brightness', direction: 'down', step: 2, steps: 6 }),
        slid({ label: 'Brightness', direction: 'down', step: 0, steps: 6, at: 'off' }),
        slid({ label: 'Brightness', direction: 'up', step: 6, steps: 6, at: 'max' }),
        slid({ label: 'Brightness', level: 94, cameOn: true }),
        slid({ label: 'Brightness', direction: 'down', step: 1, steps: 6, cameOn: true }),
        slid({ label: 'State', power: 'off' }),
        slid({ label: 'Brightness', at: 'max' }, 'skipped'),
      ]),
    ).toEqual([
      'Keuken: Ceiling - ran: Brightness+ 1/6',
      'Keuken: Ceiling - ran: Brightness- 2/6',
      'Keuken: Ceiling - ran: Brightness- 0/6 (off)',
      'Keuken: Ceiling - ran: Brightness+ 6/6 (max)',
      'Keuken: Ceiling - ran: On to Brightness 94',
      'Keuken: Ceiling - ran: On to Brightness 1/6',
      'Keuken: Ceiling - ran: Off',
      'Keuken: Ceiling - ignored: Brightness maxed',
    ]);
  });

  it('says a timer was called off without saying why again', async () => {
    const timer = (outcome: string, detail: string) =>
      entry({ ruleId: 't1', ruleName: 'Aanrecht', ruleKind: 'timer', outcome, detail });

    expect(
      await lines([
        timer('started', 'waiting 00:02'),
        timer('cancelled', 'is "OFF" no longer'),
        timer('fired', '1 action sent'),
      ]),
    ).toEqual([
      'Keuken: Aanrecht - started: waiting 00:02',
      'Keuken: Aanrecht - called off',
      'Keuken: Aanrecht - ran: 1 action sent',
    ]);
  });

  it('calls a rule that held itself back ignored', async () => {
    expect(
      await lines([entry({ outcome: 'rateLimited', detail: 'Fired 651ms ago, minimum 1000ms' })]),
    ).toEqual(['Woonkamer: All Off - ignored: Fired 651ms ago, minimum 1000ms']);
  });

  it('leaves presses out of the list until they are asked for', async () => {
    const ui = await openInterface({
      state: { devices },
      rules,
      log: [
        entry({ ruleId: 'zigbee:0xr', ruleKind: 'action', ruleName: 'remote', press }),
        entry({ press }),
      ],
    });
    await ui.click(ui.byText('button.tab', 'Activity'));

    // A press that set a rule off is on that rule line, so the list opens
    // without a column of presses beside it.
    expect(ui.document.querySelectorAll('#activity-log .log-line')).toHaveLength(1);
  });
});
