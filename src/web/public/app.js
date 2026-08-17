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

/** Marks the one failure that means "show the login form", not "something broke". */
const NOT_SIGNED_IN = 'not-signed-in';

/** What each function turns into in HomeKit, shown next to the checkbox. */
const ROLE_LABELS = {
  power: 'on/off',
  brightness: 'brightness',
  childLock: 'child lock',
  temperature: 'temperature sensor',
  humidity: 'humidity sensor',
  battery: 'battery',
  thermostatMode: 'thermostat mode',
  targetTemperature: 'thermostat setpoint',
  localTemperature: 'thermostat reading',
  action: 'buttons',
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  // Signing in has its own 401, meaning a wrong password. Intercepting it here
  // too would report every failure as "Not signed in" and hide which it was.
  if (response.status === 401 && path !== '/api/login') {
    showLogin();
    throw new Error(NOT_SIGNED_IN);
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
  safeRender();
}

/**
 * A rendering fault must not look like a failed sign in.
 *
 * Letting it throw would unwind into the sign in handler, which would send the
 * user back to the login form with a misleading message.
 */
function safeRender() {
  try {
    render();
  } catch (error) {
    console.error('Rendering failed', error);
    setStatus(`display error: ${error.message}`, 'lost');
  }
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
    // Brightness only exists on a Lightbulb, so selecting it settles the tile
    // type and the picker would otherwise be lying.
    const dimmable = device.properties.some(
      (property) =>
        property.role === 'brightness' &&
        property.endpoint === endpoint &&
        device.exposure.properties.includes(property.key),
    );

    select.value = dimmable ? 'Lightbulb' : device.exposure.tileTypes?.[endpoint] ?? 'Switch';
    select.disabled = device.rulesOnly || dimmable;
    select.title = dimmable ? 'Fixed to Lightbulb because brightness is selected' : '';
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
    // Brightness locks the tile picker to Lightbulb, and actions reveal their
    // per button gestures, so both change what is on screen.
    if (property.role === 'brightness' || property.role === 'action') {
      safeRender();
    }
  });

  const label = document.createElement('label');
  label.htmlFor = checkbox.id;
  label.textContent = property.label;

  const meta = document.createElement('span');
  meta.className = 'key';
  meta.textContent = property.key;
  label.append(' ', meta);

  const tag = document.createElement('span');
  tag.className = 'tag';
  if (property.publishable) {
    // Say what it becomes, since these are no longer all plain switches.
    tag.classList.add('publishable');
    tag.textContent = ROLE_LABELS[property.role] ?? 'HomeKit';
    tag.title = 'Tick to publish this to HomeKit.';
  } else {
    // Be explicit that this is not a dead end, it is still usable in rules.
    tag.textContent = property.writable ? 'automation only' : 'read only';
    tag.title = 'No HomeKit equivalent. Still available to the rules engine.';
  }
  label.append(tag);

  const value = document.createElement('span');
  value.className = device.state[property.key] === undefined ? 'value' : 'value set';
  value.dataset.value = `${key(device)}|${property.key}`;
  value.textContent = formatValue(device, property.key);

  row.append(checkbox, label, value);

  // An action property carries several physical buttons, each with gestures
  // that can be published independently.
  if (property.buttons?.length && checkbox.checked && !device.rulesOnly) {
    const group = document.createElement('div');
    group.className = 'buttons';
    group.append(...property.buttons.map((button) => renderButton(device, property, button)));

    const wrapper = document.createElement('div');
    wrapper.append(row, group);
    return wrapper;
  }

  return row;
}

const GESTURE_LABELS = { 0: 'single', 1: 'double', 2: 'long' };

function renderButton(device, property, button) {
  const row = document.createElement('div');
  row.className = 'button-row';

  const name = document.createElement('span');
  name.className = 'button-name';
  name.textContent = button.name;
  row.append(name);

  const selection = device.exposure.buttons?.[property.key]?.[button.name];

  for (const gesture of button.gestures) {
    const id = `b-${key(device)}-${property.key}-${button.name}-${gesture}`;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = id;
    // No stored selection means everything, which is what a device published
    // before this existed already does.
    checkbox.checked = selection === undefined || selection.includes(gesture);
    checkbox.addEventListener('change', () => {
      const buttons = { ...device.exposure.buttons };
      const perButton = { ...buttons[property.key] };
      const current = new Set(perButton[button.name] ?? button.gestures);
      if (checkbox.checked) {
        current.add(gesture);
      } else {
        current.delete(gesture);
      }
      perButton[button.name] = [...current];
      buttons[property.key] = perButton;
      device.exposure.buttons = buttons;
      save(device);
    });

    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = GESTURE_LABELS[gesture] ?? `event ${gesture}`;
    row.append(checkbox, label);
  }

  if (button.unsupported.length > 0) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = `${button.unsupported.length} automation only`;
    tag.title = `HomeKit has no gesture for: ${button.unsupported.join(', ')}`;
    row.append(tag);
  }

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
    console.error('Sign in failed', error);
    // Reaching here with NOT_SIGNED_IN means the password was accepted but the
    // session that came back was not, which is a cookie problem, not a
    // credentials one.
    showLogin(
      error.message === NOT_SIGNED_IN
        ? 'Password accepted, but the session was rejected. Check that cookies are enabled for this site.'
        : error.message,
    );
  }
});

el.logout.addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

el.filter.addEventListener('input', () => {
  state.filter = el.filter.value;
  safeRender();
});

async function start() {
  await load();
  listen();
}

// A first visit has no session yet, so a plain login form is the right result
// and needs no error. Anything else is worth showing.
start().catch((error) => {
  if (error.message === NOT_SIGNED_IN) {
    showLogin();
    return;
  }
  console.error('Startup failed', error);
  showLogin(error.message);
});
