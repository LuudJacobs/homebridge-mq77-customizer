import { describe, expect, it } from 'vitest';

import { openInterface } from './helpers/interface.js';

/** A hub, two routers off it, and a sensor that only the shed router hears. */
const SCAN = {
  nodes: [
    { address: '0x001', name: 'Coordinator', kind: 'coordinator' },
    { address: '0x002', name: 'hall_socket', kind: 'router' },
    { address: '0x003', name: 'shed_socket', kind: 'router' },
    { address: '0x004', name: 'shed_sensor', kind: 'end device' },
  ],
  links: [
    { from: '0x001', to: '0x002', quality: 200 },
    { from: '0x001', to: '0x003', quality: 120 },
    { from: '0x003', to: '0x004', quality: 80 },
  ],
  at: 1_700_000_000_000,
};

async function openMap(map: unknown = SCAN) {
  const ui = await openInterface({ state: { devices: [] } });
  ui.responses['POST /api/map'] = map;
  await ui.click(ui.byText('button.tab', 'Map'));
  return ui;
}

const names = (ui: { document: Document }) =>
  [...ui.document.querySelectorAll('#map .map-node text')].map((node) => node.textContent);

describe('the page around it', () => {
  it('says which build this is, and offers a way out, at the foot', async () => {
    const ui = await openInterface({ state: { devices: [] } });
    const footer = ui.document.querySelector('.page-footer')!;

    expect(footer.querySelector('#build')).not.toBeNull();
    expect(footer.querySelector('#logout')?.textContent).toBe('Sign out');
  });

  it('says how it is doing beside the title', async () => {
    const ui = await openInterface({ state: { devices: [] } });
    // Next to the name rather than a pill of its own among the controls.
    expect(ui.document.querySelector('h1 #status')).not.toBeNull();
    expect(ui.document.querySelector('.header-actions #status')).toBeNull();
  });

  it('signs out when the footer link is pressed', async () => {
    const ui = await openInterface({ state: { devices: [] } });
    await ui.click(ui.document.querySelector('#logout'));

    expect(ui.requests.some((request) => request.path === '/api/logout')).toBe(true);
    // And the way back in is offered rather than an empty page.
    expect((ui.document.querySelector('#login') as HTMLElement).hidden).toBe(false);
  });

  it('has no in HomeKit only or enabled only filters', async () => {
    const ui = await openInterface({ state: { devices: [] } });
    expect(ui.document.querySelector('#exposed-only')).toBeNull();
    expect(ui.document.querySelector('#enabled-only')).toBeNull();
  });
});

describe('the map tab', () => {
  it('scans nothing until it is asked to', async () => {
    const ui = await openMap();
    // A scan questions every device in turn, so it is never automatic.
    expect(ui.requests.some((request) => request.path === '/api/map')).toBe(false);
    expect(ui.document.querySelector('#map')!.textContent).toContain('Nothing scanned yet');
  });

  it('draws a device per node once scanned', async () => {
    const ui = await openMap();
    await ui.click(ui.byText('button', 'Scan the network'));

    expect(names(ui).sort()).toEqual(['Coordinator', 'hall_socket', 'shed_sensor', 'shed_socket']);
    expect(ui.document.querySelectorAll('#map .map-link')).toHaveLength(3);
  });

  it('marks the way back to the hub', async () => {
    const ui = await openMap();
    await ui.click(ui.byText('button', 'Scan the network'));

    // Every link is drawn, and the route each device uses stands out.
    expect(ui.document.querySelectorAll('#map .map-link.route')).toHaveLength(3);
  });

  it('puts each device as far from the hub as it sits', async () => {
    const ui = await openMap();
    await ui.click(ui.byText('button', 'Scan the network'));

    const columns = new Map<string, number>();
    for (const group of ui.document.querySelectorAll('#map .map-node')) {
      const name = group.querySelector('text')!.textContent!;
      columns.set(name, Number(group.querySelector('rect')!.getAttribute('x')));
    }

    // A hop per column, so the sensor behind the shed socket is one further
    // right, and the two sockets share a column.
    expect(columns.get('Coordinator')!).toBeLessThan(columns.get('shed_socket')!);
    expect(columns.get('shed_socket')!).toBeLessThan(columns.get('shed_sensor')!);
    expect(columns.get('hall_socket')).toBe(columns.get('shed_socket'));
  });

  it('tells you about a device when you click it', async () => {
    const ui = await openMap();
    await ui.click(ui.byText('button', 'Scan the network'));

    const shed = [...ui.document.querySelectorAll('#map .map-node')].find(
      (group) => group.querySelector('text')?.textContent === 'shed_socket',
    )!;
    shed.dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
    await ui.settle();

    const tip = ui.document.querySelector('#map-tip') as HTMLElement;
    expect(tip.hidden).toBe(false);
    expect(tip.textContent).toContain('shed_socket');
    expect(tip.textContent).toContain('router');
    // Link quality belongs to the device rather than to a line to hunt for.
    expect(tip.textContent).toContain('Coordinator · 120');
    expect(tip.textContent).toContain('shed_sensor · 80');
  });

  it('says how good each link is, in the panel and on the line', async () => {
    const ui = await openMap();
    await ui.click(ui.byText('button', 'Scan the network'));

    const shed = [...ui.document.querySelectorAll('#map .map-node')].find(
      (group) => group.querySelector('text')?.textContent === 'shed_socket',
    )!;
    shed.dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
    await ui.settle();

    const numbers = [...ui.document.querySelectorAll('#map-tip li strong')].map((node) => ({
      text: node.textContent,
      className: node.className,
    }));
    // The number alone, with the word dropped, coloured by how good it is.
    expect(numbers).toEqual([
      { text: '120', className: '' },
      { text: '80', className: 'poor' },
    ]);

    // The lines say the same thing.
    expect(ui.document.querySelectorAll('#map .map-link.good')).toHaveLength(1);
    expect(ui.document.querySelectorAll('#map .map-link.poor')).toHaveLength(1);
  });

  it('keeps the panel inside the map rather than off the edge', async () => {
    const ui = await openMap();
    await ui.click(ui.byText('button', 'Scan the network'));

    const node = ui.document.querySelector('#map .map-node')!;
    node.dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true, clientX: 9999 }));
    await ui.settle();

    const tip = ui.document.querySelector('#map-tip') as HTMLElement;
    // jsdom measures nothing, so this only proves it is placed rather than
    // left to run off: the clamp itself needs a real browser.
    expect(tip.style.left).not.toBe('');
    expect(Number.parseFloat(tip.style.left)).toBeGreaterThanOrEqual(0);
  });

  it('keeps one panel open at a time, and closes on a click away', async () => {
    const ui = await openMap();
    await ui.click(ui.byText('button', 'Scan the network'));

    const nodes = [...ui.document.querySelectorAll('#map .map-node')];
    nodes[0]!.dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
    await ui.settle();
    const tip = ui.document.querySelector('#map-tip') as HTMLElement;
    const first = tip.textContent;

    nodes[1]!.dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
    await ui.settle();
    expect(ui.document.querySelectorAll('#map-tip')).toHaveLength(1);
    expect(tip.textContent).not.toBe(first);

    ui.document.body.dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true }));
    await ui.settle();
    expect(tip.hidden).toBe(true);
  });

  it('shows a device nothing connects to, rather than dropping it', async () => {
    const ui = await openMap({
      ...SCAN,
      nodes: [...SCAN.nodes, { address: '0x009', name: 'lost_thing', kind: 'end device' }],
    });
    await ui.click(ui.byText('button', 'Scan the network'));

    const adrift = ui.document.querySelector('#map .map-node.adrift text');
    expect(adrift?.textContent).toBe('lost_thing');
  });

  it('names a device that did not answer the scan', async () => {
    const ui = await openMap({
      ...SCAN,
      nodes: SCAN.nodes.map((node) =>
        node.address === '0x002' ? { ...node, failed: true } : node,
      ),
    });
    await ui.click(ui.byText('button', 'Scan the network'));

    const failed = ui.document.querySelector('#map .map-node.failed text');
    expect(failed?.textContent).toBe('hall_socket');
  });

  it('says what went wrong instead of drawing nothing', async () => {
    const ui = await openInterface({ state: { devices: [] } });
    await ui.click(ui.byText('button.tab', 'Map'));
    ui.failures['POST /api/map'] = { status: 502, body: { error: 'coordinator is busy' } };

    await ui.click(ui.byText('button', 'Scan the network'));
    expect(ui.document.querySelector('#map-status')!.textContent).toContain('busy');
  });

  it('leaves the filter box out, since nothing here is filtered', async () => {
    const ui = await openMap();
    expect((ui.document.querySelector('#filter') as HTMLInputElement).hidden).toBe(true);
  });

  it('empties the log when Clear is pressed', async () => {
    const ui = await openInterface({ state: { devices: [] } });
    ui.responses['/api/log'] = {
      entries: [
        {
          at: Date.now(),
          ruleId: 'r1',
          ruleName: 'Something',
          ruleKind: 'standard',
          outcome: 'fired',
          detail: '1 action sent',
        },
      ],
    };
    await ui.click(ui.byText('button.tab', 'Activity'));
    expect(ui.document.querySelectorAll('#activity-log .log-line')).toHaveLength(1);

    await ui.click(ui.document.querySelector('#clear-log'));
    expect(ui.requests.some((request) => request.path === '/api/log')).toBe(true);
    expect(ui.document.querySelector('#activity-log')!.textContent).toContain('Nothing has run');
  });

  it('is in the dropdown that stands in for the tabs, since it is drawable', async () => {
    const ui = await openMap();
    const options = [...ui.document.querySelectorAll('#tab-select option')].map(
      (option) => option.textContent,
    );

    // A window too narrow for eight tabs is still wide enough for a network.
    // Only a phone drops it, which the tab itself is hidden on as well.
    expect(options).toEqual([
      'Devices',
      'Automation',
      'Mirror devices',
      'Sliders',
      'Timers',
      'Controllers',
      'Activity',
      'Map',
    ]);
  });
});
