// Deliberately dependency free and unbuilt, so it can be edited in place on
// the Pi and reloaded without a toolchain.

const state = {
  devices: [],
  tileTypes: [],
  filter: '',
  /** Hides everything that is not currently published to HomeKit. */
  exposedOnly: false,
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
  exposedOnly: document.getElementById('exposed-only'),
  logout: document.getElementById('logout'),
};

const key = (device) => `${device.sourceId}:${device.deviceId}`;

/** What the device is called here: the given name, or the source's own. */
const displayName = (device) => device.exposure.label?.trim() || device.name;

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
        .then(() => {
          refreshBadge(device);
          if (state.exposedOnly) {
            // Unticking a device's last function should take it off the list.
            safeRender();
          }
        })
        .catch((error) => setStatus(error.message, 'lost'));
    }, 250),
  );
}

/** How many of a device's functions actually reach HomeKit. */
function exposedCount(device) {
  if (device.rulesOnly) {
    return 0;
  }
  return device.exposure.properties.filter((propertyKey) =>
    device.properties.some((property) => property.key === propertyKey && property.publishable),
  ).length;
}

function paintBadge(badge, device) {
  if (device.rulesOnly) {
    // Not "none": this device is doing its job, it just does it in rules.
    badge.textContent = 'rules only';
    badge.className = 'badge rules';
    return;
  }
  const count = exposedCount(device);
  badge.textContent = count === 0 ? 'not in HomeKit' : `${count} in HomeKit`;
  badge.className = count === 0 ? 'badge none' : 'badge';
}

function refreshBadge(device) {
  const badge = el.devices.querySelector(`[data-badge="${CSS.escape(key(device))}"]`);
  if (badge) {
    paintBadge(badge, device);
  }
}

function matchesFilter(device, term) {
  if (!term) {
    return true;
  }
  // The topic is searched too: a Zigbee2MQTT description overrides the
  // friendly name, so the topic is often the name the user actually knows.
  return [displayName(device), device.name, device.topic, device.model, device.manufacturer, device.deviceId]
    .filter(Boolean)
    .some((field) => field.toLowerCase().includes(term));
}

function render() {
  const term = state.filter.trim().toLowerCase();
  const visible = state.devices.filter(
    (device) =>
      matchesFilter(device, term) && (!state.exposedOnly || exposedCount(device) > 0),
  );

  el.devices.replaceChildren();

  if (visible.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent =
      state.devices.length === 0
        ? 'No devices discovered yet.'
        : state.exposedOnly
          ? 'Nothing is published to HomeKit yet.'
          : 'No matches.';
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
  name.textContent = displayName(device);
  const meta = document.createElement('span');
  meta.className = 'device-meta';
  meta.textContent = [device.manufacturer, device.model].filter(Boolean).join(' ');
  // Only visible once the card is open, where there is room for it.
  const topic = document.createElement('span');
  topic.className = 'device-topic';
  topic.textContent = device.topic ?? '';
  const badge = document.createElement('span');
  badge.dataset.badge = key(device);
  if (device.renameable && !device.rulesOnly) {
    summary.append(renameButton(device, name));
  }
  summary.append(name, meta, topic, badge);
  card.append(summary);

  const body = document.createElement('div');
  body.className = 'device-body';

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

/**
 * The pencil in the card header, which swaps the name for a field.
 *
 * Everything in here has to stop the click reaching the summary, otherwise
 * editing the name would collapse the card under the cursor.
 */
function renameButton(device, name) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'rename-button';
  button.title = 'Rename this device';
  button.setAttribute('aria-label', `Rename ${displayName(device)}`);
  button.textContent = '\u270E';

  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    startRename(device, name, button);
  });

  return button;
}

function startRename(device, name, button) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'device-rename';
  input.value = device.exposure.label ?? '';
  input.placeholder = device.name;
  input.maxLength = 64;

  const swallow = (event) => event.stopPropagation();
  input.addEventListener('click', (event) => {
    event.preventDefault();
    swallow(event);
  });
  input.addEventListener('keydown', (event) => {
    swallow(event);
    if (event.key === 'Enter' || event.key === 'Escape') {
      event.preventDefault();
      input.blur();
    }
  });

  const finish = () => {
    device.exposure.label = input.value.trim();
    name.textContent = displayName(device);
    input.replaceWith(name);
    button.hidden = false;
    save(device);
  };
  input.addEventListener('blur', finish, { once: true });

  button.hidden = true;
  name.replaceWith(input);
  input.focus();
  input.select();
}

function renderOptions(device) {
  const wrap = document.createElement('div');
  wrap.className = 'options';

  // Shown whenever the device could take a tile, not only once something is
  // ticked, so the choice can be made before or after selecting functions.
  const endpoints = device.rulesOnly
    ? []
    : device.endpoints.filter((endpoint) => hasPublishableRole(device, endpoint, 'power'));

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
    // Brightness exists only on a Lightbulb and speed or swing only on a Fan,
    // so selecting one settles the tile and the picker would otherwise be lying.
    const forced = forcedTile(device, endpoint);

    select.value = forced ?? device.exposure.tileTypes?.[endpoint] ?? 'Switch';
    select.disabled = Boolean(forced);
    select.title = forced ? `Fixed to ${forced} by the functions selected` : '';
    select.addEventListener('change', () => {
      device.exposure.tileTypes = { ...device.exposure.tileTypes, [endpoint]: select.value };
      save(device);
    });
    option.append(label, select);
    wrap.append(option);
  }

  // Splitting depends on any publishable function being spread across
  // endpoints, not only on/off, so it is counted separately from the tiles.
  const splittable = device.rulesOnly
    ? []
    : device.endpoints.filter((endpoint) =>
        device.properties.some(
          (property) => property.endpoint === endpoint && property.publishable,
        ),
      );

  if (splittable.filter(Boolean).length > 1) {
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

/** Could this endpoint carry the role at all, whether or not it is ticked. */
function hasPublishableRole(device, endpoint, role) {
  return device.properties.some(
    (property) => property.role === role && property.endpoint === endpoint && property.publishable,
  );
}

function hasSelectedRole(device, endpoint, role) {
  return device.properties.some(
    (property) =>
      property.role === role &&
      property.endpoint === endpoint &&
      device.exposure.properties.includes(property.key),
  );
}

/** The tile a selection forces, if any. Mirrors what the mapper does. */
function forcedTile(device, endpoint) {
  if (hasSelectedRole(device, endpoint, 'brightness')) {
    return 'Lightbulb';
  }
  if (
    hasSelectedRole(device, endpoint, 'rotationSpeed') ||
    hasSelectedRole(device, endpoint, 'swingMode')
  ) {
    return 'Fan';
  }
  return undefined;
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

  // A rules only source publishes nothing, so a row of dead checkboxes would
  // only invite clicking them.
  const selectable = !device.rulesOnly && property.publishable;
  if (!selectable) {
    row.classList.add('unselectable');
  }

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.id = `p-${key(device)}-${property.key}`;
  checkbox.checked = device.exposure.properties.includes(property.key);
  checkbox.disabled = !property.publishable;
  checkbox.addEventListener('change', () => {
    const selected = new Set(device.exposure.properties);
    if (checkbox.checked) {
      selected.add(property.key);
    } else {
      selected.delete(property.key);
    }
    device.exposure.properties = [...selected];
    save(device);
    // On/off decides whether the tile picker is shown at all, brightness,
    // speed and swing decide what it is locked to, and actions reveal their
    // per button gestures. All of them change what belongs on screen.
    if (['power', 'brightness', 'rotationSpeed', 'swingMode', 'action'].includes(property.role)) {
      safeRender();
    }
  });

  const label = document.createElement('label');
  if (selectable) {
    label.htmlFor = checkbox.id;
  }
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

  if (selectable) {
    row.append(checkbox, label, value);
  } else {
    row.append(label, value);
  }

  // An action property carries several physical buttons, each with gestures
  // that can be published independently.
  if (property.buttons?.length && selectable && checkbox.checked) {
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

el.exposedOnly.addEventListener('change', () => {
  state.exposedOnly = el.exposedOnly.checked;
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
