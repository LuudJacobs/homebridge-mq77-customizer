/**
 * Draws every kind of activity log line into one page.
 *
 * The lines are built by the interface itself rather than written out here, so
 * the preview cannot drift from what the browser will show. Both widths are
 * drawn in frames of their own, since the narrow layout is a media query and
 * only a real viewport answers one.
 *
 *   node tools/log-preview.mjs [out.html]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { JSDOM, VirtualConsole } from 'jsdom';

const read = (name) => readFileSync(fileURLToPath(new URL(`../src/web/public/${name}`, import.meta.url)), 'utf8');

const property = (over = {}) => ({
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

const device = (deviceId, name, exposure, properties = [property()]) => ({
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
  device('0xk', 'bar', { label: 'Bar', room: 'Keuken', type: 'light' }),
];

const ref = (deviceId, propertyKey = 'state') => ({ sourceId: 'zigbee', deviceId, propertyKey });

const rules = [
  {
    id: 'r1',
    kind: 'standard',
    name: 'All Off',
    enabled: true,
    triggers: [{ ...ref('0xr', 'action'), match: { kind: 'equals', value: '4_single_long' } }],
    actions: [{ ...ref('0xw'), value: 'OFF' }],
  },
  {
    id: 'r2',
    kind: 'standard',
    name: 'Light Cycle',
    enabled: true,
    triggers: [{ ...ref('0xw'), match: { kind: 'changedTo', value: 'ON' } }],
    actions: [{ ...ref('0xw'), value: 'ON' }],
  },
  {
    id: 'r3',
    kind: 'standard',
    name: 'Bar',
    enabled: true,
    triggers: [{ ...ref('0xk'), match: { kind: 'changedTo', value: 'ON' } }],
    actions: [{ ...ref('0xk'), value: 'ON' }],
  },
  { id: 'm1', kind: 'mirror', name: 'Lichten', enabled: true, groups: [[ref('0xa'), ref('0xb')]] },
  { id: 's1', kind: 'slider', name: 'Ceiling', enabled: true, target: ref('0xc', 'brightness'), steps: 6 },
  {
    id: 't1',
    kind: 'timer',
    name: 'Aanrecht Reenable',
    enabled: true,
    triggers: [{ ...ref('0xc', 'brightness'), match: { kind: 'equals', value: 1 } }],
    waitMs: 2000,
    actions: [{ ...ref('0xc', 'brightness'), value: 0 }],
  },
];

const press = (value) => ({ sourceId: 'zigbee', deviceId: '0xr', propertyKey: 'action', value });

let clock = Date.parse('2026-08-25T19:20:13Z');
const at = () => (clock += 7_000);

const entry = (over) => ({
  at: at(),
  ruleId: 'r1',
  ruleName: 'All Off',
  ruleKind: 'standard',
  outcome: 'fired',
  detail: '2 actions sent',
  ...over,
});

const slid = (step, over = {}) =>
  entry({ ruleId: 's1', ruleName: 'Ceiling', ruleKind: 'slider', detail: '', step, ...over });

const timer = (outcome, detail, over = {}) =>
  entry({ ruleId: 't1', ruleName: 'Aanrecht Reenable', ruleKind: 'timer', outcome, detail, ...over });

const log = [
  entry({ press: press('4_single_long') }),
  entry({ press: press('1_single'), branch: 'None' }),
  entry({ ruleId: 'r2', ruleName: 'Light Cycle', branch: 'Zithoek Only', detail: '1 action sent' }),
  entry({ ruleId: 'zigbee:0xr', ruleName: 'remote', ruleKind: 'action', detail: 'Action 2_triple', press: press('2_triple') }),
  entry({
    ruleId: 'm1',
    ruleName: 'Lichten',
    ruleKind: 'mirror',
    detail: 'State copied to State',
    copy: { from: ref('0xa'), to: [ref('0xb')] },
  }),
  slid({ label: 'Brightness', direction: 'up', step: 1, steps: 6 }, { press: press('1_single') }),
  slid({ label: 'Brightness', direction: 'down', step: 2, steps: 6 }),
  slid({ label: 'Brightness', direction: 'up', step: 6, steps: 6, at: 'max' }),
  slid({ label: 'Brightness', direction: 'down', step: 0, steps: 6, at: 'off' }),
  slid({ label: 'Brightness', level: 94, cameOn: true }),
  slid({ label: 'Brightness', direction: 'down', step: 1, steps: 6, cameOn: true }),
  slid({ label: 'State', power: 'on' }),
  slid({ label: 'State', power: 'off' }),
  slid({ label: 'Brightness', at: 'max' }, { outcome: 'skipped' }),
  timer('started', 'waiting 00:02', { press: press('left_double') }),
  timer('cancelled', 'is "OFF" no longer'),
  timer('fired', '1 action sent'),
  entry({ ruleId: 'r3', ruleName: 'Bar', outcome: 'rateLimited', detail: 'Fired 651ms ago, minimum 1000ms' }),
  entry({ ruleId: 'r2', ruleName: 'Light Cycle', outcome: 'conditionsFailed', detail: 'Zithoek Only: Licht is not ON' }),
  entry({ ruleId: 'r2', ruleName: 'Light Cycle', outcome: 'failed', branch: 'Zithoek Only', detail: 'Licht cannot be written to' }),
  entry({ ruleId: 'r3', ruleName: 'Bar', outcome: 'disabled', detail: 'Fired too often, so it was turned off. Check it is not triggering itself' }),
];

const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (error) => console.error(String(error)));

const dom = new JSDOM(readFileSync(fileURLToPath(new URL('../src/web/public/index.html', import.meta.url)), 'utf8'), {
  runScripts: 'outside-only',
  url: 'http://localhost/',
  virtualConsole,
});
const { window } = dom;

const responses = {
  '/api/state': { tileTypes: ['Switch', 'Outlet', 'Lightbulb', 'Fan'], devices },
  '/api/rules': { rules },
  '/api/log': { entries: log },
};

window.fetch = (path) =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(responses[path] ?? { ok: true }),
    headers: { getSetCookie: () => [] },
  });
window.structuredClone = structuredClone;
window.matchMedia = (query) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} });
window.EventSource = class {};

window.eval(read('app.js'));
for (let turn = 0; turn < 12; turn += 1) {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

const settle = async () => {
  for (let turn = 0; turn < 12; turn += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
};

// The list is drawn for the tab it lives in.
[...window.document.querySelectorAll('button.tab')]
  .find((tab) => tab.textContent.trim() === 'Activity')
  .click();
await settle();

// Presses of their own are left out of the list by default. The preview is
// about the lines themselves, so it shows them.
const box = window.document.getElementById('kind-action');
box.checked = true;
box.dispatchEvent(new window.Event('change'));
await settle();

const lines = window.document.getElementById('activity-log').innerHTML;
if (!lines.includes('log-line')) {
  throw new Error('the interface drew nothing');
}

const frame = JSON.stringify({ css: read('app.css'), lines });
const out = process.argv[2] ?? 'log-preview.html';

writeFileSync(
  out,
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Activity log preview</title>
    <style>
      body {
        margin: 0;
        padding: 1.5rem;
        background: #14161a;
        color: #e7e9ee;
        font: 15px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      h1 { font-size: 1.1rem; margin: 0 0 0.25rem; }
      p { margin: 0 0 1.5rem; color: #8b93a4; font-size: 0.85rem; }
      .widths { display: flex; gap: 1.5rem; align-items: flex-start; flex-wrap: wrap; }
      .width { flex: 1 1 22rem; min-width: 0; }
      .width.narrow { flex: 0 0 23.4375rem; }
      h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em; color: #8b93a4; margin: 0 0 0.5rem; }
      iframe { width: 100%; border: 1px solid #2a2f3a; border-radius: 0.75rem; background: #1b1e25; }
    </style>
  </head>
  <body>
    <h1>Activity log</h1>
    <p>Drawn by the interface itself, so it says what the browser will. The narrow column is a frame 375px wide, which is what makes the mobile layout answer.</p>
    <div class="widths">
      <div class="width"><h2>Window</h2><iframe id="wide" height="760"></iframe></div>
      <div class="width narrow"><h2>Phone</h2><iframe id="narrow" height="1180"></iframe></div>
    </div>
    <script id="frame" type="application/json">${frame.replace(/</g, '\\u003c')}</script>
    <script>
      const { css, lines } = JSON.parse(document.getElementById('frame').textContent);
      const page =
        '<!doctype html><meta charset="utf-8"><style>' +
        css +
        'body{margin:0;padding:0.75rem;background:transparent}</style>' +
        '<div class="log">' +
        lines +
        '</div>';
      for (const id of ['wide', 'narrow']) {
        const frame = document.getElementById(id);
        frame.contentDocument.open();
        frame.contentDocument.write(page);
        frame.contentDocument.close();
      }
    </script>
  </body>
</html>
`,
  'utf8',
);

console.log(`wrote ${out}`);
