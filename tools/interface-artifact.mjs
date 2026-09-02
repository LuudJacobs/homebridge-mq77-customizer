/**
 * Builds a clickable copy of the web interface, for looking at before installing.
 *
 * The interface is the real one: `index.html`, `app.css` and `app.js` exactly
 * as they are on the branch this runs against, with the broker and the server
 * replaced by a stub that answers out of memory. Nothing it does leaves the
 * page and nothing is written anywhere.
 *
 *   node tools/interface-artifact.mjs [out.html]
 *
 * Published as an artifact on every push to `test` that changes the frontend,
 * to the same URL each time.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (name) =>
  readFileSync(fileURLToPath(new URL(`../src/web/public/${name}`, import.meta.url)), 'utf8');

const commit = execSync('git rev-parse --short HEAD').toString().trim();
const branch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();

// The icon is a file the stub does not serve, so it travels inline.
const favicon = `data:image/svg+xml;base64,${Buffer.from(read('favicon.svg')).toString('base64')}`;

const html = read('index.html');
const body = html
  .slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>'))
  .replace(/<script src="\/app\.js"[^>]*><\/script>/, '')
  .replaceAll('/favicon.svg', favicon);

// --- what the stub answers with --------------------------------------------

const ago = (minutes) => ({ minutesAgo: minutes });

const property = (over) => ({
  endpoint: '',
  category: 'primary',
  readable: true,
  writable: false,
  publishable: false,
  ...over,
});

const power = (key = 'state', label = 'State') =>
  property({
    key,
    label,
    semantic: 'state',
    type: 'binary',
    writable: true,
    publishable: true,
    role: 'power',
    onValue: 'ON',
    offValue: 'OFF',
    toggleValue: 'TOGGLE',
  });

const brightness = property({
  key: 'brightness',
  label: 'Brightness',
  semantic: 'brightness',
  type: 'numeric',
  writable: true,
  publishable: true,
  role: 'brightness',
  min: 0,
  max: 254,
});

const battery = property({
  key: 'battery',
  label: 'Battery',
  semantic: 'battery',
  type: 'numeric',
  category: 'diagnostic',
  publishable: true,
  role: 'battery',
  unit: '%',
  min: 0,
  max: 100,
});

const ACTIONS = ['1_single', '1_double', '2_single', '2_double'];

const action = property({
  key: 'action',
  label: 'Action',
  semantic: 'action',
  type: 'enum',
  publishable: true,
  role: 'action',
  values: ACTIONS,
  buttons: [
    { name: '1', gestures: [0, 1], unsupported: [], events: { '1_single': 0, '1_double': 1 } },
    { name: '2', gestures: [0, 1], unsupported: [], events: { '2_single': 0, '2_double': 1 } },
  ],
});

const device = (over) => ({
  sourceId: 'zigbee',
  rulesOnly: false,
  renameable: false,
  endpoints: [''],
  state: {},
  lastSeen: {},
  exposure: { properties: [] },
  ...over,
});

const LAMP = '0x00158dfffe000003';
const REMOTE = '0x00158dfffe000005';
const SENSOR = '0x00158dfffe000004';

const devices = [
  device({
    deviceId: LAMP,
    name: 'kitchen_dimmer-candeo',
    topic: 'zigbee2mqtt/kitchen_dimmer-candeo',
    manufacturer: 'Candeo',
    model: 'C202',
    retained: false,
    properties: [power(), brightness],
    exposure: {
      properties: ['state', 'brightness'],
      label: 'Plafond',
      room: 'Keuken',
      type: 'light',
      tileTypes: {},
    },
    state: { state: 'ON', brightness: 191 },
  }),
  device({
    deviceId: REMOTE,
    name: 'living_room_remote-tuya',
    topic: 'zigbee2mqtt/living_room_remote-tuya',
    manufacturer: 'Tuya',
    model: 'TS0044',
    retained: true,
    reportedLastSeen: ago(263),
    properties: [action, battery],
    exposure: {
      properties: ['action', 'battery'],
      label: 'Remote',
      room: 'Woonkamer',
      type: 'controller',
      buttons: { action: { 1: [0, 1], 2: [0] } },
      tileTypes: {},
    },
    state: { action: '1_single', battery: 61 },
  }),
  device({
    deviceId: SENSOR,
    name: 'bedroom_sensor-aqara',
    topic: 'zigbee2mqtt/bedroom_sensor-aqara',
    manufacturer: 'Aqara',
    model: 'WSDCGQ11LM',
    retained: true,
    reportedLastSeen: ago(188),
    properties: [
      property({
        key: 'temperature',
        label: 'Temperature',
        semantic: 'temperature',
        type: 'numeric',
        publishable: true,
        role: 'temperature',
        unit: '°C',
      }),
      battery,
    ],
    exposure: {
      properties: ['temperature', 'battery'],
      label: 'Sensor',
      room: 'Slaapkamer',
      type: 'sensor',
      tileTypes: {},
    },
    state: { temperature: 18.4, battery: 88 },
  }),
];

const ref = (deviceId, propertyKey = 'state') => ({ sourceId: 'zigbee', deviceId, propertyKey });

/** Between them, every shape the rule editor can now hold. */
const rules = [
  {
    id: 'a1',
    kind: 'standard',
    name: 'Avond',
    enabled: true,
    triggers: [{ kind: 'time', at: '22:00' }],
    branches: [{ actions: [{ ...ref(LAMP), value: 'ON' }] }],
  },
  {
    id: 'a2',
    kind: 'standard',
    name: 'Zonsondergang',
    enabled: true,
    triggers: [{ kind: 'time', at: 'sunset', offset: -30 }],
    branches: [{ actions: [{ ...ref(LAMP), value: 'ON' }] }],
  },
  {
    id: 'a3',
    kind: 'standard',
    name: 'Werkdagen',
    enabled: true,
    triggers: [{ kind: 'time', at: '07:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'] }],
    branches: [{ actions: [{ ...ref(LAMP), value: 'ON' }] }],
  },
  {
    id: 'a4',
    kind: 'standard',
    name: 'Nachtlamp',
    enabled: true,
    triggers: [{ ...ref(REMOTE, 'action'), match: { kind: 'changedTo', value: '1_single' } }],
    branches: [
      {
        when: { kind: 'all', nodes: [{ kind: 'time', from: '22:00', to: '06:00' }] },
        actions: [{ ...ref(LAMP), value: 'ON' }],
      },
    ],
  },
  {
    id: 't1',
    kind: 'timer',
    name: 'Tien minuten uit',
    enabled: true,
    triggers: [{ ...ref(LAMP), match: { kind: 'changedTo', value: 'ON' } }],
    waitMs: 600_000,
    actions: [{ ...ref(LAMP), value: 'OFF' }],
  },
];

const snapshot = {
  devices,
  tileTypes: ['Switch', 'Outlet', 'Lightbulb', 'Fan'],
  links: {},
  build: `${branch} ${commit}`,
  backupAt: ago(38),
  hasLocation: true,
};

const log = [
  {
    at: ago(2),
    ruleId: 'a1',
    ruleName: 'Keuken: Avond',
    ruleKind: 'standard',
    outcome: 'fired',
    detail: '1 action sent',
    firedAt: { at: '22:00' },
  },
  {
    at: ago(46),
    ruleId: 'a2',
    ruleName: 'Keuken: Zonsondergang',
    ruleKind: 'standard',
    outcome: 'fired',
    detail: '1 action sent',
    firedAt: { at: 'sunset', offset: -30 },
  },
  {
    at: ago(140),
    ruleId: 'a4',
    ruleName: 'Keuken: Nachtlamp',
    ruleKind: 'standard',
    outcome: 'conditionsFailed',
    detail: 'not between 22:00 and 06:00',
    press: { sourceId: 'zigbee', deviceId: REMOTE, propertyKey: 'action', value: '1_single' },
  },
];

// --- the stub, which runs before the interface does -------------------------

const stub = `
// Everything the interface would ask a server for, answered out of memory.
// Ticking a box, writing a rule and picking a time all work and are
// remembered while the page is open. Nothing is written and nothing leaves.
(() => {
  const opened = Date.now();

  // Ages were written down when this was built; here they become times.
  const settle = (value) => {
    if (Array.isArray(value)) return value.map(settle);
    if (value && typeof value === 'object') {
      if (typeof value.minutesAgo === 'number') return opened - value.minutesAgo * 60000;
      return Object.fromEntries(Object.entries(value).map(([key, held]) => [key, settle(held)]));
    }
    return value;
  };

  const snapshot = settle(${JSON.stringify(snapshot)});
  // Written into the document just before this runs, by the switch above the
  // frame, so the rule that hides the sun times can be watched doing it.
  snapshot.hasLocation = window.__mq77?.hasLocation !== false;
  for (const device of snapshot.devices) {
    if (typeof device.reportedLastSeen === 'number') {
      device.reportedLastSeen = new Date(device.reportedLastSeen).toISOString();
    }
  }

  const rules = ${JSON.stringify(rules)};
  const log = settle(${JSON.stringify(log)});

  const answer = (body, status = 200) =>
    Promise.resolve({
      ok: status < 400,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    });

  window.fetch = (path, options = {}) => {
    const method = options.method ?? 'GET';
    const sent = options.body ? JSON.parse(options.body) : undefined;

    if (path === '/api/state') return answer(snapshot);
    if (path === '/api/rules' && method === 'GET') return answer({ rules });
    if (path === '/api/log' && method === 'GET') return answer({ entries: log });
    if (path === '/api/log' && method === 'DELETE') {
      log.length = 0;
      return answer({ ok: true });
    }

    if (path === '/api/rules' && method === 'PUT') {
      const at = rules.findIndex((rule) => rule.id === sent.id);
      if (at >= 0) rules[at] = sent;
      else rules.push({ ...sent, id: sent.id ?? \`r\${rules.length + 1}\` });
      return answer({ rule: sent });
    }
    if (path.startsWith('/api/rules/') && method === 'DELETE') {
      const id = decodeURIComponent(path.slice('/api/rules/'.length));
      const at = rules.findIndex((rule) => rule.id === id);
      if (at >= 0) rules.splice(at, 1);
      return answer({ ok: true });
    }

    if (path === '/api/exposure' && method === 'PUT') {
      const device = snapshot.devices.find(
        (candidate) =>
          candidate.sourceId === sent.sourceId && candidate.deviceId === sent.deviceId,
      );
      if (device) device.exposure = sent.exposure;
      return answer({ ok: true });
    }

    return answer({ ok: true });
  };

  // Nothing arrives on its own here.
  window.EventSource = class {
    close() {}
  };
})();
`;

const frame = [
  '<!doctype html><meta charset="utf-8">',
  `<style>${read('app.css')}</style>`,
  body,
  `<script>${stub}</script>`,
  `<script type="module">${read('app.js')}</script>`,
].join('\n');

const page = `<title>MQ77 Interface Sandbox</title>
<style>
  :root {
    --page: #eceff4;
    --panel: #ffffff;
    --ink: #1b1d22;
    --muted: #5c6470;
    --line: #d5dae2;
    --accent: #2f6fed;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --body: system-ui, -apple-system, 'Segoe UI', sans-serif;
  }

  :root:not([data-theme='light']) {
    color-scheme: light dark;
  }

  @media (prefers-color-scheme: dark) {
    :root:not([data-theme='light']) {
      --page: #101216;
      --panel: #171a1f;
      --ink: #e6e8ec;
      --muted: #8c94a1;
      --line: #252932;
      --accent: #6f9bff;
    }
  }

  :root[data-theme='dark'] {
    --page: #101216;
    --panel: #171a1f;
    --ink: #e6e8ec;
    --muted: #8c94a1;
    --line: #252932;
    --accent: #6f9bff;
  }

  body {
    margin: 0;
    padding: 2.5rem 1.5rem 4rem;
    background: var(--page);
    color: var(--ink);
    font-family: var(--body);
    line-height: 1.55;
  }

  .sheet {
    max-width: 70rem;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 1.75rem;
  }

  .masthead {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .build {
    font-family: var(--mono);
    font-size: 0.75rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
  }

  h1 {
    margin: 0;
    font-size: 1.65rem;
    font-weight: 650;
    letter-spacing: -0.015em;
    text-wrap: balance;
  }

  .purpose {
    margin: 0;
    max-width: 62ch;
    color: var(--muted);
  }

  .changes {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
    gap: 1px;
    background: var(--line);
    border: 1px solid var(--line);
    border-radius: 10px;
    overflow: hidden;
  }

  .change {
    background: var(--panel);
    padding: 0.9rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .change h2 {
    margin: 0;
    font-family: var(--mono);
    font-size: 0.78rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--accent);
  }

  .change p {
    margin: 0;
    font-size: 0.87rem;
    color: var(--muted);
  }

  .stage {
    border: 1px solid var(--line);
    border-radius: 10px;
    overflow: hidden;
    background: var(--panel);
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.6rem 0.75rem;
    border-bottom: 1px solid var(--line);
    flex-wrap: wrap;
  }

  .controls span {
    font-family: var(--mono);
    font-size: 0.72rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    margin-right: 0.35rem;
  }

  .controls span + span {
    margin-left: 1rem;
  }

  .controls button {
    font: inherit;
    font-family: var(--mono);
    font-size: 0.78rem;
    padding: 0.2rem 0.7rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
  }

  .controls button:hover {
    color: var(--ink);
  }

  .controls button[aria-pressed='true'] {
    border-color: var(--accent);
    color: var(--accent);
  }

  .controls button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .viewport {
    display: flex;
    justify-content: center;
    padding: 1rem;
    overflow-x: auto;
  }

  iframe {
    width: 100%;
    max-width: 100%;
    height: 48rem;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--page);
  }

  .footnote {
    margin: 0;
    font-size: 0.82rem;
    color: var(--muted);
    max-width: 62ch;
  }

  code {
    font-family: var(--mono);
    font-size: 0.9em;
  }
</style>

<div class="sheet">
  <header class="masthead">
    <p class="build">${branch} · ${commit}</p>
    <h1>MQ77 Interface Sandbox</h1>
    <p class="purpose">
      The real interface, running against a stubbed broker. Open the Automation tab:
      four rules there use every shape a time can take. Write your own, pick a time,
      save it. Nothing is saved anywhere and nothing leaves this page.
    </p>
  </header>

  <div class="changes">
    <section class="change">
      <h2>time as a trigger</h2>
      <p>Time sits at the bottom of the trigger picker, under the devices. Choosing it
        turns the row into a time and the seven days, and a clock is drawn where a
        device would carry its kind.</p>
    </section>
    <section class="change">
      <h2>the sun</h2>
      <p>Sunrise, sunset, dawn and dusk, with minutes either side. Only offered while a
        location is set: turn the switch off and watch them go, and watch the rule that
        already uses one keep saying it.</p>
    </section>
    <section class="change">
      <h2>a window as a condition</h2>
      <p>Nachtlamp runs on a press, but only between 22:00 and 06:00. The
        activity log shows one that was turned away.</p>
    </section>
  </div>

  <div class="stage">
    <div class="controls">
      <span>width</span>
      <button type="button" data-width="100%" aria-pressed="true">window</button>
      <button type="button" data-width="48rem" aria-pressed="false">tablet</button>
      <button type="button" data-width="23.4375rem" aria-pressed="false">phone</button>
      <span>location</span>
      <button type="button" id="location" aria-pressed="true">set</button>
    </div>
    <div class="viewport">
      <iframe id="app-frame" title="MQ77 Customizer web interface"></iframe>
    </div>
  </div>

  <p class="footnote">
    Everything the plugin would do to a device happens here to nothing at all, so
    switching a light on moves the tile and reaches no lamp. The Map has nothing to
    draw, and the downloads are inert: the artifact viewer never hands a file over.
  </p>
</div>

<script id="interface" type="application/json">${JSON.stringify(frame).replace(/</g, '\\u003c')}</script>
<script>
  const page = JSON.parse(document.getElementById('interface').textContent);
  const frame = document.getElementById('app-frame');
  const located = document.getElementById('location');

  const draw = () => {
    // Written ahead of everything else in the frame, since the stub reads it
    // before the interface asks for any state. Setting the frame's name would
    // not do: a window keeps the name it was navigated with.
    const set = located.getAttribute('aria-pressed') === 'true';
    frame.contentDocument.open();
    frame.contentDocument.write(
      '<script>window.__mq77 = { hasLocation: ' + set + ' };<' + '/script>' + page,
    );
    frame.contentDocument.close();
  };
  draw();

  for (const button of document.querySelectorAll('.controls button[data-width]')) {
    button.addEventListener('click', () => {
      for (const other of document.querySelectorAll('.controls button[data-width]')) {
        other.setAttribute('aria-pressed', String(other === button));
      }
      frame.style.width = button.dataset.width;
      // The interface reads the width on load for the tab bar and the map, so
      // it is drawn again rather than resized under itself.
      draw();
    });
  }

  located.addEventListener('click', () => {
    const set = located.getAttribute('aria-pressed') !== 'true';
    located.setAttribute('aria-pressed', String(set));
    located.textContent = set ? 'set' : 'not set';
    draw();
  });
</script>
`;

const out = process.argv[2] ?? 'interface-artifact.html';
writeFileSync(out, page, 'utf8');
console.log(`wrote ${out} (${(page.length / 1024).toFixed(0)}kb)`);
