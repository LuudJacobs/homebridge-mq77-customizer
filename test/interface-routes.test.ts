import { describe, expect, it } from 'vitest';

import { openInterface } from './helpers/interface.js';

const property = (key: string, role: string, over: Record<string, unknown> = {}) => ({
  key,
  label: key,
  semantic: key,
  type: 'binary',
  category: 'primary',
  endpoint: '',
  readable: true,
  writable: false,
  publishable: true,
  role,
  onValue: true,
  offValue: false,
  ...over,
});

const device = (deviceId: string, label: string, room: string, properties: unknown[]) => ({
  sourceId: 'zigbee',
  deviceId,
  name: `sensor_${deviceId}`,
  topic: `zigbee2mqtt/sensor_${deviceId}`,
  manufacturer: 'Aqara',
  model: 'X',
  rulesOnly: false,
  renameable: false,
  endpoints: [''],
  properties,
  exposure: { properties: [], room, label, type: 'sensor' },
  state: {},
  lastSeen: {},
});

const devices = () => [
  device('0xa', 'Beweging', 'Bedroom', [property('occupancy', 'motion')]),
  device('0xb', 'Gang', 'Hal', [property('presence', 'occupancy')]),
  device('0xc', 'Deur', 'Living room', [property('contact', 'contact')]),
  device('0xe', 'Bank', 'Living room', [property('occupancy', 'motion')]),
  device('0xd', 'Lamp', 'Living room', [
    property('state', 'power', { writable: true, onValue: 'ON', offValue: 'OFF' }),
  ]),
];

const sensor = (id: string) => ({ sourceId: 'zigbee', deviceId: id });
const routes = [
  {
    id: 'route-1',
    name: 'Bedroom to living room',
    sensors: [sensor('0xa'), sensor('0xb'), sensor('0xe')],
    walkMs: 30_000,
    bothWays: true,
  },
];

describe('the Routes page', () => {
  async function open(over: { routes?: unknown[] } = {}) {
    return openInterface({ state: { devices: devices(), routes: over.routes ?? routes }, at: '/home/routes' });
  }
  const card = (ui: { document: Document }) =>
    ui.document.querySelector('#routes details.route') as HTMLDetailsElement;

  it('lists each route with its sensors and which way it goes', async () => {
    const ui = await open();
    expect(ui.window.location.pathname).toBe('/home/routes');
    const summary = card(ui).querySelector('summary')!;
    expect(summary.querySelector('.device-name')?.textContent).toBe('Bedroom to living room');
    expect(summary.querySelector('.device-meta')?.textContent).toBe('3 sensors · both ways');
  });

  it('offers only motion and presence sensors, in order, to move up and down', async () => {
    const ui = await open();
    await ui.openCard(card(ui));
    const picks = [...card(ui).querySelectorAll('select.route-sensor')] as HTMLSelectElement[];
    expect(picks.map((pick) => pick.options[pick.selectedIndex]?.textContent)).toEqual([
      'Bedroom Beweging',
      'Hal Gang',
      'Living room Bank',
    ]);
    const offered = [...picks[0]!.options].map((option) => option.textContent);
    expect(offered).not.toContain('Living room Lamp');
    // A door says when it opens, never that nobody is there.
    expect(offered).not.toContain('Living room Deur');

    const down = [...card(ui).querySelectorAll('.route-sensors .rule-row')][0]!.querySelectorAll('button')[1] as HTMLButtonElement;
    await ui.click(down);
    await ui.click([...card(ui).querySelectorAll('.rule-footer button')].find((b) => b.textContent === 'Save')!);
    const saved = ui.requests.findLast((request) => request.path === '/api/routes')?.body as {
      route: { sensors: { deviceId: string }[] };
    };
    expect(saved.route.sensors.map((entry) => entry.deviceId)).toEqual(['0xb', '0xa', '0xe']);
  });

  it('adds one at the top, thirty seconds and both ways, saved without an id of its own', async () => {
    const ui = await open({ routes: [] });
    await ui.click(ui.document.getElementById('add-route'));
    const fresh = card(ui);
    expect(fresh.open).toBe(true);
    const name = fresh.querySelector('input[type="text"]') as HTMLInputElement;
    name.value = 'Hal naar deur';
    name.dispatchEvent(new ui.window.Event('input'));
    await ui.click(ui.byText('#routes button.add-row', '+ sensor'));
    await ui.click(ui.byText('#routes button.add-row', '+ sensor'));
    await ui.click([...fresh.querySelectorAll('.rule-footer button')].find((b) => b.textContent === 'Save')!);

    const saved = ui.requests.findLast((request) => request.path === '/api/routes')?.body as {
      route: Record<string, unknown>;
    };
    expect(saved.route).toEqual({
      name: 'Hal naar deur',
      sensors: [sensor('0xa'), sensor('0xb')],
      walkMs: 30_000,
      bothWays: true,
    });
  });
});

describe('a route walked, as a trigger', () => {
  const lamp = { ...sensor('0xd'), propertyKey: 'state', value: 'ON' };
  const rule = (trigger: unknown, when?: unknown) => ({
    id: 'r1',
    name: 'Licht',
    enabled: true,
    triggers: [trigger],
    branches: [{ ...(when ? { when } : {}), actions: [lamp] }],
  });
  const door = { ...sensor('0xc'), propertyKey: 'contact', match: { kind: 'changed' } };

  async function openRule(trigger: unknown, over: { routes?: unknown[]; when?: unknown } = {}) {
    const ui = await openInterface({
      state: { devices: devices(), routes: over.routes ?? routes },
      rules: [rule(trigger, over.when)],
    });
    await ui.click(ui.byText('button.tab', 'Rules'));
    await ui.openCard(ui.document.querySelector('.rule') as HTMLDetailsElement);
    return ui;
  }
  const selectsIn = (ui: { document: Document }, where: string) =>
    [...ui.document.querySelector(`${where} .rule-row`)!.querySelectorAll('select')] as HTMLSelectElement[];
  const selects = (ui: { document: Document }) => selectsIn(ui, '.triggers');
  const saved = async (ui: Awaited<ReturnType<typeof openRule>>) => {
    await ui.click(ui.byText('button.primary', 'Save', '#automation'));
    return (
      ui.requests.findLast((request) => request.path === '/api/rules' && request.body)?.body as {
        triggers: unknown[];
      }
    ).triggers[0];
  };
  const pick = async (ui: Awaited<ReturnType<typeof openRule>>, select: HTMLSelectElement, value: string) => {
    select.value = value;
    select.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();
  };

  it('is offered above Current time, once there are routes', async () => {
    const ui = await openRule(door);
    const rooms = [...selects(ui)[0]!.options].map((option) => option.textContent);
    expect(rooms.slice(-2)).toEqual(['Routes', 'Current time']);

    const none = await openRule(door, { routes: [] });
    expect([...selects(none)[0]!.options].map((option) => option.textContent)).not.toContain('Routes');
  });

  it('is not offered in a condition', async () => {
    const ui = await openRule(door, {
      when: { kind: 'test', ...sensor('0xa'), propertyKey: 'occupancy', match: { kind: 'equals', value: 'true' } },
    });
    const rooms = [...selectsIn(ui, '.condition-group')[0]!.options].map((option) => option.textContent);
    expect(rooms).not.toContain('Routes');
    expect(rooms.at(-1)).toBe('Current time');
  });

  it('picks either way, or towards the room at one end', async () => {
    const ui = await openRule({ kind: 'route', routeId: 'route-1', direction: 'back' });
    const [rooms, route, direction] = selects(ui);
    expect(rooms!.value).toBe('__route');
    expect(route!.options[route!.selectedIndex]?.textContent).toBe('Bedroom to living room');
    expect([...direction!.options].map((option) => option.textContent)).toEqual([
      'either way',
      'towards Living room',
      'towards Bedroom',
    ]);
    expect(direction!.value).toBe('back');

    await pick(ui, direction!, '');
    expect(await saved(ui)).toEqual({ kind: 'route', routeId: 'route-1' });
  });

  it('has no way to pick on a route that goes one way', async () => {
    const ui = await openRule(
      { kind: 'route', routeId: 'route-1' },
      { routes: [{ ...routes[0], bothWays: false }] },
    );
    expect(selects(ui)).toHaveLength(2);
  });

  it('turns a device row into a route, and back into a device that saves', async () => {
    const ui = await openRule(door);
    await pick(ui, selects(ui)[0]!, '__route');
    expect(await saved(ui)).toEqual({ kind: 'route', routeId: 'route-1' });

    await pick(ui, selects(ui)[0]!, 'Hal');
    expect(await saved(ui)).toMatchObject({ deviceId: '0xb', propertyKey: 'presence' });
  });

  it('reads in the rule list under the route’s name', async () => {
    const ui = await openRule({ kind: 'route', routeId: 'route-1', direction: 'forward' });
    const title = ui.document.querySelector('.rule summary')?.textContent?.replace(/\s+/g, ' ');
    expect(title).toContain('Bedroom to living room →');
  });
});

describe('a walk in the log', () => {
  it('names the route and which way it was walked', async () => {
    const ui = await openInterface({
      state: { devices: devices(), routes },
      log: [
        {
          at: 1_700_000_000_000,
          ruleId: 'r1',
          ruleName: 'Licht',
          ruleKind: 'standard',
          outcome: 'fired',
          detail: '1 action sent',
          walked: { routeId: 'route-1', routeName: 'Bedroom to living room', direction: 'back' },
        },
      ],
    });
    await ui.click(ui.byText('button.tab', 'Log'));
    const line = ui.document.querySelector('#activity-log .log-what')?.textContent?.replace(/\s+/g, ' ');
    expect(line).toContain('Bedroom to living room: walked towards Bedroom →');
  });
});

describe('a door on a route made before doors were left out', () => {
  it('says it is not a motion sensor, rather than that it has gone', async () => {
    const ui = await openInterface({
      state: { devices: devices(), routes: [{ ...routes[0], sensors: [sensor('0xa'), sensor('0xc')] }] },
      at: '/home/routes',
    });
    const card = ui.document.querySelector('#routes details.route') as HTMLDetailsElement;
    await ui.openCard(card);
    const picks = [...card.querySelectorAll('select.route-sensor')] as HTMLSelectElement[];
    expect(picks[1]!.options[picks[1]!.selectedIndex]?.textContent).toBe(
      'Living room Deur (not a motion sensor)',
    );
  });
});
