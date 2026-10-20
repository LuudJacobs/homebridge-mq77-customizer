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
  device('0xd', 'Lamp', 'Living room', [
    property('state', 'power', { writable: true, onValue: 'ON', offValue: 'OFF' }),
  ]),
];

const sensor = (id: string) => ({ sourceId: 'zigbee', deviceId: id });
const routes = [
  {
    id: 'route-1',
    name: 'Bedroom to living room',
    sensors: [sensor('0xa'), sensor('0xb'), sensor('0xc')],
    gapMs: 10_000,
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

  it('offers only what notices somebody as a sensor, in order, to move up and down', async () => {
    const ui = await open();
    await ui.openCard(card(ui));
    const picks = [...card(ui).querySelectorAll('select.route-sensor')] as HTMLSelectElement[];
    expect(picks.map((pick) => pick.options[pick.selectedIndex]?.textContent)).toEqual([
      'Bedroom Beweging',
      'Hal Gang',
      'Living room Deur',
    ]);
    expect([...picks[0]!.options].map((option) => option.textContent)).not.toContain('Living room Lamp');

    const down = [...card(ui).querySelectorAll('.route-sensors .rule-row')][0]!.querySelectorAll('button')[1] as HTMLButtonElement;
    await ui.click(down);
    await ui.click([...card(ui).querySelectorAll('.rule-footer button')].find((b) => b.textContent === 'Save')!);
    const saved = ui.requests.findLast((request) => request.path === '/api/routes')?.body as {
      route: { sensors: { deviceId: string }[] };
    };
    expect(saved.route.sensors.map((entry) => entry.deviceId)).toEqual(['0xb', '0xa', '0xc']);
  });

  it('adds one at the top, ten seconds and both ways, saved without an id of its own', async () => {
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
      gapMs: 10_000,
      bothWays: true,
    });
  });
});

describe('a route in a condition', () => {
  const rule = (when?: unknown) => ({
    id: 'r1',
    name: 'Licht',
    enabled: true,
    triggers: [{ ...sensor('0xc'), propertyKey: 'contact', match: { kind: 'changed' } }],
    branches: [{ ...(when ? { when } : {}), actions: [{ ...sensor('0xd'), propertyKey: 'state', value: 'ON' }] }],
  });

  async function openRule(when?: unknown, withRoutes = true) {
    const ui = await openInterface({
      state: { devices: devices(), routes: withRoutes ? routes : [] },
      rules: [rule(when)],
    });
    await ui.click(ui.byText('button.tab', 'Rules'));
    await ui.openCard(ui.document.querySelector('.rule') as HTMLDetailsElement);
    return ui;
  }
  const row = (ui: { document: Document }) => ui.document.querySelector('.condition-group .rule-row')!;
  const selects = (ui: { document: Document }) => [...row(ui).querySelectorAll('select')] as HTMLSelectElement[];
  const saved = async (ui: Awaited<ReturnType<typeof openRule>>) => {
    await ui.click(ui.byText('button.primary', 'Save', '#automation'));
    return (ui.requests.findLast((request) => request.path === '/api/rules' && request.body)?.body as {
      branches: { when: unknown }[];
    }).branches[0]?.when;
  };

  it('is offered above Current time, once there are routes', async () => {
    const ui = await openRule({ kind: 'test', ...sensor('0xa'), propertyKey: 'occupancy', match: { kind: 'equals', value: 'true' } });
    const rooms = [...selects(ui)[0]!.options].map((option) => option.textContent);
    expect(rooms.slice(-2)).toEqual(['Routes', 'Current time']);

    const none = await openRule({ kind: 'test', ...sensor('0xa'), propertyKey: 'occupancy', match: { kind: 'equals', value: 'true' } }, false);
    expect([...selects(none)[0]!.options].map((option) => option.textContent)).not.toContain('Routes');
  });

  it('asks who is on it, at which sensor, and towards which room', async () => {
    const ui = await openRule({ kind: 'route', routeId: 'route-1', test: 'towards', direction: 'back' });
    const [rooms, route, test, direction] = selects(ui);
    expect(rooms!.value).toBe('__route');
    expect(route!.options[route!.selectedIndex]?.textContent).toBe('Bedroom to living room');
    expect([...test!.options].map((option) => option.textContent)).toEqual([
      'is on it',
      'is not on it',
      'is at',
      'towards',
    ]);
    // Named by the room at that end of the route.
    expect([...direction!.options].map((option) => option.textContent)).toEqual(['Living room', 'Bedroom']);
    expect(direction!.value).toBe('back');
    expect(await saved(ui)).toEqual({ kind: 'route', routeId: 'route-1', test: 'towards', direction: 'back' });
  });

  it('turns a device row into a route, and back into a device that saves', async () => {
    const ui = await openRule({ kind: 'test', ...sensor('0xa'), propertyKey: 'occupancy', match: { kind: 'equals', value: 'true' } });
    selects(ui)[0]!.value = '__route';
    selects(ui)[0]!.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();
    expect(await saved(ui)).toEqual({ kind: 'route', routeId: 'route-1', test: 'on' });

    selects(ui)[0]!.value = 'Hal';
    selects(ui)[0]!.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();
    expect(await saved(ui)).toMatchObject({ kind: 'test', deviceId: '0xb' });
  });

  it('keeps a condition a test when it goes from a time back to a device', async () => {
    const ui = await openRule({ kind: 'time', at: '22:00', side: 'after' });
    selects(ui)[0]!.value = 'Hal';
    selects(ui)[0]!.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();
    expect(await saved(ui)).toMatchObject({ kind: 'test', deviceId: '0xb' });
  });
});
