// Deliberately dependency free and unbuilt, so it can be edited in place on
// the Pi and reloaded without a toolchain.

const state = {
  devices: [],
  tileTypes: [],
  filter: '',
  /** Device keys whose card is open, kept across re-renders. */
  open: new Set(),
};

const el = {
  login: document.getElementById('login'),
  loginForm: document.getElementById('login-form'),
  password: document.getElementById('password'),
  loginError: document.getElementById('login-error'),
  app: document.getElementById('app'),
  devices: document.getElementById('devices'),
  filter: document.getElementById('filter'),
  status: document.getElementById('status'),
  logout: document.getElementById('logout'),
};

const key = (device) => `${device.sourceId}:${device.deviceId}`;

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (response.status === 401) {
    showLogin();
    throw new Error('Not signed in');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (${response.status})`);
  }
  return response.json();
}

function showLogin(message) {
  el.app.hidden = true;
  el.login.hidden = false;
  el.loginError.hidden = !message;
  el.loginError.textContent = message ?? '';
  el.password.focus();
}

function showApp() {
  el.login.hidden = true;
  el.app.hidden = false;
}

async function load() {
  const snapshot = await api('/api/state');
  state.devices = snapshot.devices;
  state.tileTypes = snapshot.tileTypes;
  showApp();
  render();
}

function setStatus(text, kind) {
  el.status.textContent = text;
  el.status.className = `status ${kind ?? ''}`;
}

function listen() {
  const events = new EventSource('/api/events');

  events.onopen = () => setStatus('live', 'live');

  events.onerror = () => setStatus('reconnecting', 'lost');

  events.onmessage = (message) => {
    const payload = JSON.parse(message.data);
    if (payload.type === 'devices') {
      // The catalog changed, so a device may have joined, left or been renamed.
      load().catch(() => {});
      return;
    }
    if (payload.type === 'state') {
      const device = state.devices.find(
        (candidate) =>
          candidate.sourceId === payload.sourceId && candidate.deviceId === payload.deviceId,
      );
      if (!device) {
        return;
      }
      Object.assign(device.state, payload.changes);
      for (const propertyKey of Object.keys(payload.changes)) {
        device.lastSeen[propertyKey] = payload.at;
        updateValue(device, propertyKey);
      }
    }
  };
}

/** Patches one value in place, so typing in a field is never interrupted. */
function updateValue(device, propertyKey) {
  const node = el.devices.querySelector(
    `[data-value="${CSS.escape(key(device))}|${CSS.escape(propertyKey)}"]`,
  );
  if (node) {
    node.textContent = formatValue(device, propertyKey);
    node.classList.add('set');
  }
}

function formatValue(device, propertyKey) {
  const value = device.state[propertyKey];
  if (value === undefined) {
    return 'no value yet';
  }
  const property = device.properties.find((candidate) => candidate.key === propertyKey);
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return property?.unit ? `${text} ${property.unit}` : text;
}

const pending = new Map();

/** Debounced per device, so ticking several boxes quickly is one write. */
function save(device) {
  clearTimeout(pending.get(key(device)));
  pending.set(
    key(device),
    setTimeout(() => {
      api('/api/exposure', {
        method: 'PUT',
        body: JSON.stringify({
          sourceId: device.sourceId,
          deviceId: device.deviceId,
          exposure: device.exposure,
        }),
      })
        .then(() => refreshBadge(device))
        .catch((error) => setStatus(error.message, 'lost'));
    }, 250),
  );
}

function paintBadge(badge, device) {
  const count = device.exposure.properties.filter((propertyKey) =>
    device.properties.some(
      (property) => property.key === propertyKey && property.publishable,
    ),
  ).length;
  badge.textContent = count === 0 ? 'not in HomeKit' : `${count} in HomeKit`;
  badge.className = count === 0 ? 'badge none' : 'badge';
}

function refreshBadge(device) {
  const badge = el.devices.querySelector(`[data-badge="${CSS.escape(key(device))}"]`);
  if (badge) {
    paintBadge(badge, device);
  }
}

function render() {
  const term = state.filter.trim().toLowerCase();
  const visible = state.devices.filter(
    (device) =>
      !term ||
      device.name.toLowerCase().includes(term) ||
      (device.model ?? '').toLowerCase().includes(term) ||
      device.deviceId.toLowerCase().includes(term),
  );

  el.devices.replaceChildren();

  if (visible.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = state.devices.length === 0 ? 'No devices discovered yet.' : 'No matches.';
    el.devices.append(empty);
    return;
  }

  for (const device of visible) {
    el.devices.append(renderDevice(device));
  }
}

function renderDevice(device) {
  const card = document.createElement('details');
  card.className = 'device';
  card.open = state.open.has(key(device));
  card.addEventListener('toggle', () => {
    if (card.open) {
      state.open.add(key(device));
    } else {
      state.open.delete(key(device));
    }
  });

  const summary = document.createElement('summary');
  const name = document.createElement('span');
  name.className = 'device-name';
  name.textContent = device.name;
  const meta = document.createElement('span');
  meta.className = 'device-meta';
  meta.textContent = [device.manufacturer, device.model].filter(Boolean).join(' ');
  const badge = document.createElement('span');
  badge.dataset.badge = key(device);
  summary.append(name, meta, badge);
  card.append(summary);

  const body = document.createElement('div');
  body.className = 'device-body';

  if (device.rulesOnly) {
    const note = document.createElement('p');
    note.className = 'rules-only';
    note.textContent =
      'This source is set to rules only, so nothing here is published to HomeKit.';
    body.append(note);
  }

  body.append(renderOptions(device));

  for (const [title, properties] of groupProperties(device)) {
    const heading = document.createElement('p');
    heading.className = 'group-title';
    heading.textContent = title;
    body.append(heading);
    for (const property of properties) {
      body.append(renderProperty(device, property));
    }
  }

  card.append(body);
  paintBadge(badge, device);
  return card;
}

function renderOptions(device) {
  const wrap = document.createElement('div');
  wrap.className = 'options';

  const endpoints = device.endpoints.filter((endpoint) =>
    device.properties.some(
      (property) => property.endpoint === endpoint && property.publishable,
    ),
  );

  for (const endpoint of endpoints) {
    const option = document.createElement('div');
    option.className = 'option';
    const label = document.createElement('label');
    label.textContent = endpoint ? `Tile for ${endpoint}` : 'Tile';
    const select = document.createElement('select');
    for (const tile of state.tileTypes) {
      const choice = document.createElement('option');
      choice.value = tile;
      choice.textContent = tile;
      select.append(choice);
    }
    select.value = device.exposure.tileTypes?.[endpoint] ?? 'Switch';
    select.disabled = device.rulesOnly;
    select.addEventListener('change', () => {
      device.exposure.tileTypes = { ...device.exposure.tileTypes, [endpoint]: select.value };
      save(device);
    });
    option.append(label, select);
    wrap.append(option);
  }

  if (endpoints.filter(Boolean).length > 1) {
    const option = document.createElement('div');
    option.className = 'option';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = `split-${key(device)}`;
    checkbox.checked = device.exposure.splitEndpoints === true;
    checkbox.disabled = device.rulesOnly;
    checkbox.addEventListener('change', () => {
      device.exposure.splitEndpoints = checkbox.checked;
      save(device);
    });
    const label = document.createElement('label');
    label.htmlFor = checkbox.id;
    label.textContent = 'Separate accessory per endpoint';
    option.append(checkbox, label);
    wrap.append(option);
  }

  return wrap;
}

const GROUP_ORDER = [
  ['primary', 'Functions'],
  ['config', 'Settings'],
  ['diagnostic', 'Diagnostics'],
];

function groupProperties(device) {
  return GROUP_ORDER.map(([category, title]) => [
    title,
    device.properties.filter((property) => property.category === category),
  ]).filter(([, properties]) => properties.length > 0);
}

function renderProperty(device, property) {
  const row = document.createElement('div');
  row.className = 'property';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.id = `p-${key(device)}-${property.key}`;
  checkbox.checked = device.exposure.properties.includes(property.key);
  checkbox.disabled = !property.publishable || device.rulesOnly;
  checkbox.addEventListener('change', () => {
    const selected = new Set(device.exposure.properties);
    if (checkbox.checked) {
      selected.add(property.key);
    } else {
      selected.delete(property.key);
    }
    device.exposure.properties = [...selected];
    save(device);
  });

  const label = document.createElement('label');
  label.htmlFor = checkbox.id;
  label.textContent = property.label;

  const meta = document.createElement('span');
  meta.className = 'key';
  meta.textContent = property.key;
  label.append(' ', meta);

  if (!property.publishable) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    // Be explicit that this is not a dead end, it is still usable in rules.
    tag.textContent = property.writable ? 'automation only' : 'read only';
    tag.title =
      'No HomeKit equivalent in this version. Still available to the rules engine.';
    label.append(tag);
  }

  const value = document.createElement('span');
  value.className = device.state[property.key] === undefined ? 'value' : 'value set';
  value.dataset.value = `${key(device)}|${property.key}`;
  value.textContent = formatValue(device, property.key);

  row.append(checkbox, label, value);
  return row;
}

el.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ password: el.password.value }),
    });
    el.password.value = '';
    await start();
  } catch (error) {
    showLogin(error.message);
  }
});

el.logout.addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

el.filter.addEventListener('input', () => {
  state.filter = el.filter.value;
  render();
});

async function start() {
  await load();
  listen();
}

start().catch(() => showLogin());
