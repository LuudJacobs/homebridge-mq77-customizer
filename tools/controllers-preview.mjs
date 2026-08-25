/**
 * Draws the controller overview into one page, at both widths.
 *
 * The tables are built by the interface itself rather than written out here,
 * so the preview cannot drift from what the browser will show. The markdown
 * the download button writes is printed underneath, from the same function.
 *
 * With a settings file exported from the footer it draws the real thing:
 *
 *   node tools/controllers-preview.mjs out.html ~/Downloads/mq77-settings.json
 *
 * The export holds what the user set up, not what the devices said they can
 * send, so the buttons of a controller are worked back out of the values its
 * rules were built on: every button seen, crossed with every gesture seen.
 * That is a guess, but a truthful one about which are free.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { JSDOM, VirtualConsole } from 'jsdom';

const read = (name) =>
  readFileSync(fileURLToPath(new URL(`../src/web/public/${name}`, import.meta.url)), 'utf8');

/**
 * Which value HomeKit hears as which press, the way the server works it out.
 *
 * A word at either end of the value naming a press it has, and the rest of
 * the value being the button. `triple` and `release` are presses HomeKit
 * cannot express, so a value carrying one of those is heard by nobody.
 */
const HOMEKIT_PRESSES = { single: 0, press: 0, click: 0, toggle: 0, double: 1, hold: 2, long: 2 };

const homekitButtons = (values = []) => {
  const buttons = new Map();

  for (const value of values) {
    const parts = String(value).split('_');
    const [head, tail] = [parts[0]?.toLowerCase(), parts[parts.length - 1]?.toLowerCase()];
    const [name, press] =
      parts.length > 1 && head in HOMEKIT_PRESSES
        ? [parts.slice(1).join('_'), HOMEKIT_PRESSES[head]]
        : parts.length > 1 && tail in HOMEKIT_PRESSES
          ? [parts.slice(0, -1).join('_'), HOMEKIT_PRESSES[tail]]
          : [String(value), HOMEKIT_PRESSES.single];

    const button = buttons.get(name) ?? { name, gestures: [], unsupported: [], events: {} };
    if (parts.some((part) => part === 'triple' || part === 'release')) {
      button.unsupported.push(String(value));
    } else {
      button.events[String(value)] = press;
      button.gestures = [...new Set([...button.gestures, press])].sort();
    }
    buttons.set(name, button);
  }

  return [...buttons.values()];
};

const DEFAULT_ACTIONS = [
  '1_single',
  '1_double',
  '1_single_long',
  '2_single',
  '2_double',
  '3_single',
  '4_single',
];

const action = (over = {}) => {
  const values = 'values' in over ? over.values : DEFAULT_ACTIONS;
  return {
    key: 'action',
    label: 'Action',
    semantic: 'action',
    type: 'enum',
    category: 'primary',
    endpoint: '',
    readable: true,
    writable: false,
    publishable: false,
    ...over,
    values,
    buttons: homekitButtons(values),
  };
};

const state = () => ({
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
});

const brightness = () => ({
  key: 'brightness',
  label: 'Brightness',
  semantic: 'brightness',
  type: 'numeric',
  category: 'primary',
  endpoint: '',
  readable: true,
  writable: true,
  publishable: true,
  min: 0,
  max: 254,
});

const device = (deviceId, name, exposure, properties) => ({
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
  device('0xr', 'remote_woon', { label: 'Remote', room: 'Woonkamer', type: 'controller' }, [
    action(),
  ]),
  device('0xk', 'remote_keuken', { label: 'Schakelaar', room: 'Keuken', type: 'controller' }, [
    action({ values: ['left_single', 'left_double', 'right_single', 'right_double', 'both_single'] }),
  ]),
  device('0xg', 'remote_gang', { label: 'Knop', room: 'Gang', type: 'controller' }, [
    action({ values: undefined }),
  ]),
  device('0xl', 'lamp', { label: 'Licht', room: 'Woonkamer', type: 'light' }, [
    state(),
    brightness(),
  ]),
];

const starts = (deviceId, value) => ({
  sourceId: 'zigbee',
  deviceId,
  propertyKey: 'action',
  match: { kind: 'equals', value },
});

const acts = { sourceId: 'zigbee', deviceId: '0xl', propertyKey: 'state', value: 'ON' };

const rules = [
  {
    id: 'r1',
    kind: 'standard',
    name: 'Licht cycle',
    enabled: true,
    triggers: [starts('0xr', '1_single')],
    actions: [acts],
  },
  {
    id: 'r2',
    kind: 'standard',
    name: 'Alles uit',
    enabled: true,
    triggers: [starts('0xr', '1_single'), starts('0xr', '1_single_long')],
    actions: [{ ...acts, value: 'OFF' }],
  },
  {
    id: 's1',
    kind: 'slider',
    name: 'Dimmen',
    enabled: true,
    target: { sourceId: 'zigbee', deviceId: '0xl', propertyKey: 'brightness' },
    steps: 6,
    up: [starts('0xr', '2_single')],
    down: [starts('0xr', '2_double')],
    on: [starts('0xr', '3_single')],
    off: [starts('0xr', '4_single')],
  },
  {
    id: 't1',
    kind: 'timer',
    name: 'Aanrecht uit',
    enabled: true,
    triggers: [starts('0xk', 'left_double')],
    waitMs: 120_000,
    actions: [{ ...acts, value: 'OFF' }],
  },
  {
    id: 'r3',
    kind: 'standard',
    name: 'Keuken aan',
    enabled: true,
    triggers: [starts('0xk', 'left_single')],
    actions: [acts],
  },
  {
    id: 'r4',
    kind: 'standard',
    name: 'Gang aan',
    enabled: true,
    triggers: [starts('0xg', 'single')],
    actions: [acts],
  },
];

/** Devices and rules as an exported settings file describes them. */
function fromSettings(path, splitAction) {
  const settings = JSON.parse(readFileSync(path, 'utf8'));
  const rules = settings.rules ?? [];

  // What each controller's rules were built on, which is all the file says
  // about its buttons.
  const used = new Map();
  for (const rule of rules) {
    const starts = [
      ...(rule.triggers ?? []),
      rule.trigger,
      ...['up', 'down', 'on', 'off'].flatMap((key) =>
        Array.isArray(rule[key]) ? rule[key] : [rule[key]],
      ),
    ].filter(Boolean);
    for (const start of starts) {
      if (start.propertyKey !== 'action' || start.match?.value === undefined) {
        continue;
      }
      const key = `${start.sourceId}:${start.deviceId}`;
      used.set(key, [...(used.get(key) ?? []), String(start.match.value)]);
    }
  }

  const devices = Object.entries(settings.exposures ?? {}).map(([key, exposure]) => {
    const [sourceId, ...rest] = key.split(':');
    const deviceId = rest.join(':');
    // Actions are added below, from the values the rules were built on.
    const properties = (exposure.properties ?? [])
      .filter((propertyKey) => propertyKey !== 'action')
      .map((propertyKey) => ({
        key: propertyKey,
        label: propertyKey.startsWith('state')
          ? `State${propertyKey.slice(5).replace('_', ' ')}`
          : propertyKey[0].toUpperCase() + propertyKey.slice(1),
        semantic: propertyKey.startsWith('state') ? 'state' : propertyKey,
        type: propertyKey === 'brightness' ? 'numeric' : 'binary',
        category: 'primary',
        endpoint: '',
        readable: true,
        writable: true,
        publishable: true,
        role: 'power',
        onValue: 'ON',
        offValue: 'OFF',
      }));

    if (exposure.type === 'controller' || used.has(key)) {
      properties.push({
        key: 'action',
        label: 'Action',
        semantic: 'action',
        type: 'enum',
        category: 'primary',
        endpoint: '',
        readable: true,
        writable: false,
        publishable: false,
        values: everyButton(used.get(key) ?? [], splitAction),
        buttons: homekitButtons(everyButton(used.get(key) ?? [], splitAction)),
      });
    }

    return {
      sourceId,
      deviceId,
      name: exposure.label ?? deviceId,
      topic: `${sourceId}/${deviceId}`,
      manufacturer: '',
      model: '',
      rulesOnly: false,
      renameable: false,
      endpoints: [''],
      properties,
      exposure: { properties: [], ...exposure },
      state: {},
      lastSeen: {},
    };
  });

  return { devices, rules };
}

/**
 * Every button of a remote, from the handful its rules name.
 *
 * A remote sends the same gestures on each of its buttons, so the buttons and
 * the gestures seen, crossed, is a fair account of what it can send. The order
 * of the two halves is kept as the values themselves have it.
 */
function everyButton(values, splitAction) {
  const buttons = [];
  const gestures = [];
  let buttonFirst = true;

  for (const value of values) {
    const { button, gesture } = splitAction(value);
    if (!button || !gesture) {
      continue;
    }
    buttonFirst = value.startsWith(button);
    if (!buttons.includes(button)) {
      buttons.push(button);
    }
    if (!gestures.includes(gesture)) {
      gestures.push(gesture);
    }
  }

  if (buttons.length === 0) {
    return [...new Set(values)];
  }

  return buttons.flatMap((button) =>
    gestures.map((gesture) => (buttonFirst ? `${button}_${gesture}` : `${gesture}_${button}`)),
  );
}

const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (error) => console.error(String(error)));

const dom = new JSDOM(read('index.html'), {
  runScripts: 'outside-only',
  url: 'http://localhost/',
  virtualConsole,
});
const { window } = dom;

// The page has to be loaded before its splitting can be borrowed, so the file
// is read after it and the answers are looked up as they are asked for.
let shown = { devices, rules };

const responses = {
  get '/api/state'() {
    return { tileTypes: ['Switch', 'Outlet', 'Lightbulb', 'Fan'], devices: shown.devices };
  },
  get '/api/rules'() {
    return { rules: shown.rules };
  },
  '/api/log': { entries: [] },
};

window.fetch = (path) =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(responses[path] ?? { ok: true }),
    headers: { getSetCookie: () => [] },
  });
window.structuredClone = structuredClone;
window.matchMedia = (query) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
});
window.EventSource = class {};

window.eval(read('app.js'));

const settings = process.argv[3];
if (settings) {
  shown = fromSettings(settings, (value) => window.eval(`splitAction(${JSON.stringify(value)})`));
  window.eval('load()').catch?.(() => {});
}

const settle = async () => {
  for (let turn = 0; turn < 12; turn += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
};
await settle();

[...window.document.querySelectorAll('button.tab')]
  .find((tab) => tab.textContent.trim() === 'Controllers')
  .click();
await settle();

// The tick lives with the other filters up in the header, so the preview
// carries that row along with the tab underneath it.
const controls = window.document.querySelector('.header-actions').outerHTML;
// The section itself, not what is inside it: the download sits at the end of
// its line, and stands down on a phone, by rules hung on the section's id.
const section = window.document.getElementById('view-controllers');
section.removeAttribute('hidden');
const view = `<header>${controls}</header>${section.outerHTML}`;
const markdown = window.eval('controllersAsMarkdown()');
if (!view.includes('controller-card')) {
  throw new Error('the interface drew nothing');
}

const escape = (text) => text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const frame = JSON.stringify({ css: read('app.css'), view }).replace(/</g, '\\u003c');
const out = process.argv[2] ?? 'controllers-preview.html';

writeFileSync(
  out,
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Controllers preview</title>
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
      .width { flex: 1 1 24rem; min-width: 0; }
      .width.narrow { flex: 0 0 23.4375rem; }
      h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em; color: #8b93a4; margin: 0 0 0.5rem; }
      iframe { width: 100%; border: 1px solid #2a2f3a; border-radius: 0.75rem; background: #1b1e25; }
      pre {
        margin: 0;
        padding: 1rem;
        overflow-x: auto;
        border: 1px solid #2a2f3a;
        border-radius: 0.75rem;
        background: #1b1e25;
        font-size: 0.8rem;
        line-height: 1.5;
      }
      .file { margin-top: 2rem; }
    </style>
  </head>
  <body>
    <h1>Controllers</h1>
    <p>Drawn by the interface itself. The narrow column is a frame 375px wide, which is what makes the mobile layout answer: no download button there.</p>
    <div class="widths">
      <div class="width"><h2>Window</h2><iframe id="wide" height="900"></iframe></div>
      <div class="width narrow"><h2>Phone</h2><iframe id="narrow" height="900"></iframe></div>
    </div>
    <div class="file">
      <h2>controller-config.md</h2>
      <pre>${escape(markdown)}</pre>
    </div>
    <script id="frame" type="application/json">${frame}</script>
    <script>
      const { css, view } = JSON.parse(document.getElementById('frame').textContent);
      const page =
        '<!doctype html><meta charset="utf-8"><style>' +
        css +
        'body{margin:0;padding:0.75rem;background:transparent}</style>' +
        view;
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
console.log(markdown);
