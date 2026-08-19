// Deliberately dependency free and unbuilt, so it can be edited in place on
// the Pi and reloaded without a toolchain.

const state = {
  devices: [],
  tileTypes: [],
  filter: '',
  /** Hides everything that is not currently published to HomeKit. */
  exposedOnly: false,
  sort: 'name',
  /** Device keys whose card is open, kept across re-renders. */
  open: new Set(),
  view: 'devices',
  rules: [],
  openRules: new Set(),
  log: [],
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
  sort: document.getElementById('sort'),
  logout: document.getElementById('logout'),
  tabDevices: document.getElementById('tab-devices'),
  tabRules: document.getElementById('tab-rules'),
  viewDevices: document.getElementById('view-devices'),
  viewRules: document.getElementById('view-rules'),
  rules: document.getElementById('rules'),
  log: document.getElementById('log'),
  addRule: document.getElementById('add-rule'),
  zigbee2mqttLink: document.getElementById('zigbee2mqtt-link'),
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

  // Only shown when configured, so the tab bar does not carry a dead link.
  const zigbee2mqtt = snapshot.links?.zigbee2mqtt;
  el.zigbee2mqttLink.hidden = !zigbee2mqtt;
  if (zigbee2mqtt) {
    el.zigbee2mqttLink.href = zigbee2mqtt;
  }
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
    if (payload.type === 'rules') {
      if (state.view === 'rules') {
        loadRules().catch(() => {});
      }
      return;
    }
    if (payload.type === 'log') {
      state.log.unshift(payload.entry);
      state.log = state.log.slice(0, 200);
      if (state.view === 'rules') {
        renderLog();
      }
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
      const seen = el.devices.querySelector(`[data-seen="${CSS.escape(key(device))}"]`);
      if (seen) {
        paintLastSeen(seen, device);
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
    paintValue(node, device, propertyKey);
    node.classList.add('set');
  }
}

/** Writes the value, and explains it on hover when it is a timestamp. */
function paintValue(node, device, propertyKey) {
  node.textContent = formatValue(device, propertyKey);

  const property = device.properties.find((candidate) => candidate.key === propertyKey);
  const moment = asDate(property, device.state[propertyKey]);
  if (moment) {
    node.title = moment.toLocaleString();
    node.classList.add('timestamp');
  } else {
    node.removeAttribute('title');
    node.classList.remove('timestamp');
  }
}

/**
 * Reads a value as a moment in time, or nothing if it is not one.
 *
 * Zigbee2MQTT publishes `last_seen` as an ISO string or as an epoch, in
 * seconds or milliseconds depending on how it is configured, and none of those
 * is readable at a glance.
 */
function asDate(property, value) {
  if (typeof value === 'string') {
    // ISO 8601 is distinctive enough to recognise from the value alone.
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)) {
      return undefined;
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }

  // A bare number is not: linkquality 200 is not a date. Only trust one when
  // the property is named like a time.
  if (typeof value === 'number' && isTimeNamed(property)) {
    const parsed = new Date(value > 1e11 ? value : value * 1000);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }

  return undefined;
}

function isTimeNamed(property) {
  return /(^|_)(seen|time|timestamp|date|at)(_|$)/.test(property?.semantic ?? property?.key ?? '');
}

/**
 * When the device last said anything.
 *
 * Taken from the newest reading of any of its functions, so it works the same
 * for every source rather than relying on one of them publishing a timestamp.
 * Only known since this plugin started, so a quiet device has none.
 */
function deviceLastSeen(device) {
  const times = Object.values(device.lastSeen ?? {});
  return times.length > 0 ? Math.max(...times) : undefined;
}

function formatLastSeen(at) {
  const seen = new Date(at);
  const pad = (value) => String(value).padStart(2, '0');
  const time = `${pad(seen.getHours())}:${pad(seen.getMinutes())}`;

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (seen >= today) {
    return `Today ${time}:${pad(seen.getSeconds())}`;
  }
  if (seen >= yesterday) {
    return `Yesterday ${time}`;
  }
  return `${pad(seen.getDate())}-${pad(seen.getMonth() + 1)} ${time}`;
}

function paintLastSeen(node, device) {
  const at = deviceLastSeen(device);
  node.textContent = at === undefined ? '' : formatLastSeen(at);
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

/** What each ordering compares, other than last seen which is a number. */
const SORT_KEYS = {
  name: (device) => displayName(device),
  topic: (device) => device.topic ?? '',
  device: (device) => [device.manufacturer, device.model].filter(Boolean).join(' '),
};

function sortDevices(devices) {
  const sorted = [...devices];

  if (state.sort === 'seen') {
    // Newest first, and anything that has said nothing yet goes last rather
    // than pretending to be very old.
    return sorted.sort((a, b) => (deviceLastSeen(b) ?? -1) - (deviceLastSeen(a) ?? -1));
  }

  const key = SORT_KEYS[state.sort] ?? SORT_KEYS.name;
  return sorted.sort((a, b) => compareNames(key(a), key(b)) || compareNames(displayName(a), displayName(b)));
}

/** Case and accent insensitive, and puts device2 after device10 the way people expect. */
function compareNames(a, b) {
  return String(a ?? '').localeCompare(String(b ?? ''), undefined, {
    sensitivity: 'base',
    numeric: true,
  });
}

function matchesFilter(device, term) {
  if (!term) {
    return true;
  }
  // The topic is searched too: a Zigbee2MQTT description overrides the
  // friendly name, so the topic is often the name the user actually knows.
  return [
    displayName(device),
    device.name,
    device.topic,
    device.model,
    device.manufacturer,
    device.deviceId,
  ]
    .filter(Boolean)
    .some((field) => field.toLowerCase().includes(term));
}

function render() {
  const term = state.filter.trim().toLowerCase();
  const visible = sortDevices(
    state.devices.filter(
      (device) => matchesFilter(device, term) && (!state.exposedOnly || exposedCount(device) > 0),
    ),
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
  const seen = document.createElement('span');
  seen.className = 'device-seen';
  seen.dataset.seen = key(device);
  paintLastSeen(seen, device);
  // Only visible once the card is open, where there is room for it.
  const topic = document.createElement('span');
  topic.className = 'device-topic';
  topic.textContent = device.topic ?? '';
  const badge = document.createElement('span');
  badge.dataset.badge = key(device);
  // Worth offering even on a rules only device: the name is what the device
  // is called in this interface and in rules, not only in HomeKit.
  if (device.renameable) {
    summary.append(renameButton(device, name));
  }
  summary.append(name, meta, seen, topic, badge);
  card.append(summary);

  const body = document.createElement('div');
  body.className = 'device-body';

  const options = renderOptions(device);
  if (options.childElementCount > 0) {
    body.append(options);
  }

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
  paintValue(value, device, property.key);

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

el.sort.addEventListener('change', () => {
  state.sort = el.sort.value;
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

/* Rules ------------------------------------------------------------------ */

const MATCH_KINDS = [
  { kind: 'changedTo', label: 'becomes' },
  { kind: 'equals', label: 'is' },
  { kind: 'notEquals', label: 'is not' },
  { kind: 'changed', label: 'changes' },
  { kind: 'above', label: 'rises above' },
  { kind: 'below', label: 'falls below' },
];

const OUTCOME_LABELS = {
  fired: 'ran',
  rateLimited: 'held back',
  conditionsFailed: 'conditions not met',
  failed: 'failed',
  disabled: 'turned off',
};

/** By display name, for the pickers a rule is built from. */
function byName(devices) {
  return [...devices].sort((a, b) => compareNames(displayName(a), displayName(b)));
}

/** Properties a rule can watch: anything readable. */
const watchable = (device) => device.properties.filter((property) => property.readable);

/** Properties a rule can write: anything with a command topic. */
const writable = (device) => device.properties.filter((property) => property.writable);

function findDevice(ref) {
  return state.devices.find(
    (device) => device.sourceId === ref.sourceId && device.deviceId === ref.deviceId,
  );
}

function findProperty(ref) {
  return findDevice(ref)?.properties.find((property) => property.key === ref.propertyKey);
}

async function loadRules() {
  const [rules, log] = await Promise.all([api('/api/rules'), api('/api/log')]);
  state.rules = rules.rules;
  state.log = log.entries;
  renderRules();
  renderLog();
}

function renderRules() {
  el.rules.replaceChildren();
  if (state.rules.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No rules yet.';
    el.rules.append(empty);
    return;
  }
  for (const rule of state.rules) {
    el.rules.append(renderRule(rule));
  }
}

function renderRule(rule) {
  const card = document.createElement('details');
  card.className = 'device rule';
  card.open = state.openRules.has(rule.id);
  card.addEventListener('toggle', () => {
    if (card.open) {
      state.openRules.add(rule.id);
    } else {
      state.openRules.delete(rule.id);
    }
  });

  const summary = document.createElement('summary');
  const name = document.createElement('span');
  name.className = 'device-name';
  name.textContent = rule.name;
  const detail = document.createElement('span');
  detail.className = 'device-meta';
  detail.textContent = summarise(rule);
  const badge = document.createElement('span');
  badge.className = rule.enabled ? 'badge' : 'badge none';
  badge.textContent = rule.enabled ? 'on' : 'off';
  summary.append(name, detail, badge);
  card.append(summary);

  card.append(renderRuleBody(rule));
  return card;
}

function summarise(rule) {
  if (rule.kind === 'mirror') {
    const devices = new Set(
      rule.groups.flat().map((ref) => findDevice(ref)?.name ?? 'a removed device'),
    );
    const fields = rule.groups.length;
    return `${[...devices].join(' ↔ ')} · ${fields} field${fields === 1 ? '' : 's'}`;
  }
  const source = findProperty(rule.trigger);
  const target = findProperty(rule.actions[0]);
  const from = source ? `${findDevice(rule.trigger)?.name} ${source.label}` : 'a removed function';
  const to = target ? `${findDevice(rule.actions[0])?.name} ${target.label}` : 'a removed function';
  const extra = rule.actions.length > 1 ? ` and ${rule.actions.length - 1} more` : '';
  return `${from} → ${to}${extra}`;
}
function renderRuleBody(rule) {
  const body = document.createElement('div');
  body.className = 'device-body';
  const draft = structuredClone(rule);

  const nameRow = document.createElement('div');
  nameRow.className = 'option';
  const nameLabel = document.createElement('label');
  nameLabel.textContent = 'Name';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = draft.name;
  nameInput.maxLength = 80;
  nameInput.addEventListener('input', () => (draft.name = nameInput.value));
  nameRow.append(nameLabel, nameInput);

  const enabled = document.createElement('label');
  enabled.className = 'toggle';
  const enabledBox = document.createElement('input');
  enabledBox.type = 'checkbox';
  enabledBox.checked = draft.enabled;
  enabledBox.addEventListener('change', () => (draft.enabled = enabledBox.checked));
  enabled.append(enabledBox, document.createTextNode('Enabled'));

  const mirror = document.createElement('label');
  mirror.className = 'toggle';
  mirror.title = 'Keep the same function on several devices in step with each other';
  const mirrorBox = document.createElement('input');
  mirrorBox.type = 'checkbox';
  mirrorBox.checked = draft.kind === 'mirror';
  mirror.append(mirrorBox, document.createTextNode('Mirror'));

  nameRow.append(enabled, mirror);
  body.append(nameRow);

  // A mirror has no trigger and no actions, so the rest of the form is a
  // different shape entirely rather than a variation on the same one.
  const shape = document.createElement('div');
  const drawShape = () => {
    shape.replaceChildren();
    if (draft.kind === 'mirror') {
      drawMirror(shape, draft);
    } else {
      drawWhenThen(shape, draft);
    }
  };

  mirrorBox.addEventListener('change', () => {
    if (mirrorBox.checked) {
      draft.kind = 'mirror';
    } else {
      delete draft.kind;
    }
    drawShape();
  });

  drawShape();
  body.append(shape);
  body.append(ruleFooter(rule, draft));
  return body;
}

function ruleFooter(rule, draft) {
  const footer = document.createElement('div');
  footer.className = 'rule-footer';
  const error = document.createElement('span');
  error.className = 'error';

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'primary';
  save.textContent = 'Save';
  save.addEventListener('click', async () => {
    error.textContent = '';
    try {
      await api('/api/rules', { method: 'PUT', body: JSON.stringify(draft) });
      await loadRules();
    } catch (problem) {
      error.textContent = problem.message;
    }
  });

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = 'Delete';
  remove.addEventListener('click', async () => {
    await api(`/api/rules/${encodeURIComponent(rule.id)}`, { method: 'DELETE' }).catch(() => {});
    state.openRules.delete(rule.id);
    await loadRules();
  });

  footer.append(save, remove, error);
  return footer;
}

/** The ordinary trigger, conditions and actions form. */
function drawWhenThen(body, draft) {
  draft.trigger = draft.trigger ?? {
    ...blankRef(watchable),
    match: { kind: 'changedTo', value: '' },
  };
  draft.conditions = draft.conditions ?? [];
  draft.actions = draft.actions?.length ? draft.actions : [{ ...blankRef(writable), value: '' }];

  body.append(sectionTitle('When'));
  body.append(refRow(draft.trigger, { pick: watchable, withMatch: true }));

  body.append(sectionTitle('And, optionally'));
  const conditions = document.createElement('div');
  const drawConditions = () => {
    conditions.replaceChildren();
    draft.conditions.forEach((condition, index) => {
      conditions.append(
        refRow(condition, {
          pick: watchable,
          withMatch: true,
          onRemove: () => {
            draft.conditions.splice(index, 1);
            drawConditions();
          },
        }),
      );
    });
  };
  drawConditions();
  body.append(
    conditions,
    addButton('Add condition', () => {
      draft.conditions.push({ ...blankRef(watchable), match: { kind: 'equals', value: '' } });
      drawConditions();
    }),
  );

  body.append(sectionTitle('Then'));
  const actions = document.createElement('div');
  const drawActions = () => {
    actions.replaceChildren();
    draft.actions.forEach((action, index) => {
      actions.append(
        refRow(action, {
          pick: writable,
          withValue: true,
          withDelay: true,
          onRemove:
            draft.actions.length > 1
              ? () => {
                  draft.actions.splice(index, 1);
                  drawActions();
                }
              : undefined,
        }),
      );
    });
  };
  drawActions();
  body.append(
    actions,
    addButton('Add action', () => {
      draft.actions.push({ ...blankRef(writable), value: '' });
      drawActions();
    }),
  );
}

/**
 * Pick the devices, then the functions to keep in step.
 *
 * Functions are matched on meaning rather than on name: a socket calls its
 * on/off `state` and a two channel switch calls the same thing `state_l1`, and
 * mirroring one onto the other is exactly what this is for.
 */
function drawMirror(body, draft) {
  draft.groups = draft.groups ?? [];

  // The devices already in use, so an existing rule opens with them ticked.
  const chosen = new Set(
    draft.groups.flat().map((ref) => `${ref.sourceId}|${ref.deviceId}`),
  );

  body.append(sectionTitle('Devices'));
  const devices = document.createElement('div');
  devices.className = 'mirror-devices';

  const candidates = byName(state.devices.filter((device) => writable(device).length > 0));
  for (const device of candidates) {
    const id = `${device.sourceId}|${device.deviceId}`;
    const label = document.createElement('label');
    label.className = 'toggle';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = chosen.has(id);
    box.addEventListener('change', () => {
      if (box.checked) {
        chosen.add(id);
      } else {
        chosen.delete(id);
      }
      pruneGroups();
      drawFields();
    });
    label.append(box, document.createTextNode(displayName(device)));
    devices.append(label);
  }
  body.append(devices);

  const settleRow = document.createElement('div');
  settleRow.className = 'option';
  const settleLabel = document.createElement('label');
  settleLabel.textContent = 'Settle for';
  const settle = document.createElement('input');
  settle.type = 'number';
  settle.className = 'delay';
  settle.min = 0.25;
  settle.max = 60;
  settle.step = 0.25;
  settle.placeholder = '1.5';
  settle.value = draft.settleMs ? draft.settleMs / 1000 : '';
  settle.title =
    'How long the group ignores reports after being written to. Too short and two devices that disagree can trade places.';
  settle.addEventListener('input', () => {
    const seconds = Number(settle.value);
    draft.settleMs = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined;
  });
  const settleUnit = document.createElement('span');
  settleUnit.className = 'device-meta';
  settleUnit.textContent = 'seconds after a change';
  settleRow.append(settleLabel, settle, settleUnit);
  body.append(settleRow);

  body.append(sectionTitle('Functions to mirror'));
  const fields = document.createElement('div');
  body.append(fields);

  function selected() {
    return candidates.filter((device) => chosen.has(`${device.sourceId}|${device.deviceId}`));
  }

  /** Drops members of a device that is no longer ticked. */
  function pruneGroups() {
    draft.groups = draft.groups
      .map((group) => group.filter((ref) => chosen.has(`${ref.sourceId}|${ref.deviceId}`)))
      .filter((group) => group.length > 0);
  }

  /** Meanings every selected device has something for. */
  function sharedSemantics() {
    const devices = selected();
    if (devices.length < 2) {
      return [];
    }
    const [first, ...rest] = devices;
    return [...new Set(writable(first).map((property) => property.semantic).filter(Boolean))].filter(
      (semantic) =>
        rest.every((device) =>
          writable(device).some((property) => property.semantic === semantic),
        ),
    );
  }

  function labelFor(semantic) {
    const device = selected()[0];
    return (
      writable(device ?? { properties: [] }).find((property) => property.semantic === semantic)
        ?.label ?? semantic
    );
  }

  function drawFields() {
    fields.replaceChildren();
    const devices = selected();

    if (devices.length < 2) {
      const hint = document.createElement('p');
      hint.className = 'empty';
      hint.textContent = 'Pick at least two devices.';
      fields.append(hint);
      return;
    }

    const semantics = sharedSemantics();
    if (semantics.length === 0) {
      const hint = document.createElement('p');
      hint.className = 'empty';
      hint.textContent = 'These devices have no function in common that can be written to.';
      fields.append(hint);
      return;
    }

    for (const semantic of semantics) {
      const row = document.createElement('div');
      row.className = 'rule-row';

      const existing = draft.groups.find((group) =>
        group.every((ref) => findProperty(ref)?.semantic === semantic),
      );

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.id = `mirror-${semantic}`;
      box.checked = Boolean(existing);

      const label = document.createElement('label');
      label.htmlFor = box.id;
      label.textContent = labelFor(semantic);
      row.append(box, label);

      // One picker per device, because a two channel switch has two functions
      // with the same meaning and only the user knows which one is wanted.
      const pickers = document.createElement('span');
      pickers.className = 'rule-tail';

      const refs = devices.map((device) => {
        const options = writable(device).filter((property) => property.semantic === semantic);
        const already = existing?.find(
          (ref) => ref.sourceId === device.sourceId && ref.deviceId === device.deviceId,
        );
        const ref = already ?? {
          sourceId: device.sourceId,
          deviceId: device.deviceId,
          propertyKey: options[0]?.key ?? '',
        };

        if (options.length > 1) {
          const select = document.createElement('select');
          for (const option of options) {
            const choice = document.createElement('option');
            choice.value = option.key;
            choice.textContent = `${displayName(device)} ${option.endpoint || option.label}`;
            select.append(choice);
          }
          select.value = ref.propertyKey;
          select.addEventListener('change', () => {
            ref.propertyKey = select.value;
            commit();
          });
          pickers.append(select);
        }

        return ref;
      });

      row.append(pickers);

      function commit() {
        draft.groups = draft.groups.filter((group) => group !== existingGroup());
        if (box.checked) {
          draft.groups.push(refs);
        }
      }

      function existingGroup() {
        return draft.groups.find((group) =>
          group.every((ref) => findProperty(ref)?.semantic === semantic),
        );
      }

      box.addEventListener('change', commit);
      fields.append(row);
    }
  }

  drawFields();
}

function sectionTitle(text) {
  const title = document.createElement('p');
  title.className = 'group-title';
  title.textContent = text;
  return title;
}

function addButton(text, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'add-row';
  button.textContent = text;
  button.addEventListener('click', onClick);
  return button;
}

function blankRef(pick) {
  const device = state.devices.find((candidate) => pick(candidate).length > 0);
  return {
    sourceId: device?.sourceId ?? '',
    deviceId: device?.deviceId ?? '',
    propertyKey: pick(device ?? { properties: [] })[0]?.key ?? '',
  };
}

/**
 * One line of a rule: a device, one of its functions, and what to do with it.
 *
 * The same row serves triggers, conditions and actions, since all three are a
 * reference into the same normalised model.
 */
function refRow(ref, options) {
  const row = document.createElement('div');
  row.className = 'rule-row';

  const devices = document.createElement('select');
  // Always by name here, whatever the device list is sorted by. A rule is
  // written by looking for a device by name, not by when it last reported.
  for (const device of byName(state.devices.filter((candidate) => options.pick(candidate).length > 0))) {
    const choice = document.createElement('option');
    choice.value = `${device.sourceId}|${device.deviceId}`;
    choice.textContent = displayName(device);
    devices.append(choice);
  }
  devices.value = `${ref.sourceId}|${ref.deviceId}`;

  const properties = document.createElement('select');
  const fillProperties = () => {
    properties.replaceChildren();
    const device = findDevice(ref);
    for (const property of device ? options.pick(device) : []) {
      const choice = document.createElement('option');
      choice.value = property.key;
      // A multi channel device calls every channel "State", so the endpoint is
      // the only thing telling them apart.
      choice.textContent = property.endpoint
        ? `${property.label} ${property.endpoint}`
        : property.label;
      properties.append(choice);
    }
    properties.value = ref.propertyKey;
    if (!properties.value) {
      ref.propertyKey = properties.options[0]?.value ?? '';
      properties.value = ref.propertyKey;
    }
  };

  devices.addEventListener('change', () => {
    const [sourceId, deviceId] = devices.value.split('|');
    ref.sourceId = sourceId;
    ref.deviceId = deviceId;
    ref.propertyKey = '';
    fillProperties();
    redrawTail();
  });
  properties.addEventListener('change', () => {
    ref.propertyKey = properties.value;
    redrawTail();
  });

  row.append(devices, properties);

  const tail = document.createElement('span');
  tail.className = 'rule-tail';
  row.append(tail);

  function redrawTail() {
    tail.replaceChildren();
    const property = findProperty(ref);

    if (options.withMatch) {
      const kinds = document.createElement('select');
      for (const entry of MATCH_KINDS) {
        const choice = document.createElement('option');
        choice.value = entry.kind;
        choice.textContent = entry.label;
        kinds.append(choice);
      }
      kinds.value = ref.match.kind;
      kinds.addEventListener('change', () => {
        ref.match = { kind: kinds.value, value: ref.match.value ?? '' };
        redrawTail();
      });
      tail.append(kinds);

      if (ref.match.kind !== 'changed') {
        // No toggle here: it is something to send, never something a device
        // reports, so it could never match.
        tail.append(valueInput(property, ref.match.value, (value) => (ref.match.value = value)));
      }
    }

    if (options.withValue) {
      const mode = document.createElement('select');
      for (const entry of [
        { kind: 'literal', label: 'set to' },
        { kind: 'trigger', label: 'match the trigger' },
      ]) {
        const choice = document.createElement('option');
        choice.value = entry.kind;
        choice.textContent = entry.label;
        mode.append(choice);
      }
      mode.value = ref.valueFrom?.kind === 'trigger' ? 'trigger' : 'literal';
      mode.addEventListener('change', () => {
        if (mode.value === 'trigger') {
          ref.valueFrom = { kind: 'trigger' };
          delete ref.value;
        } else {
          delete ref.valueFrom;
        }
        redrawTail();
      });
      tail.append(mode);

      // Copying the trigger leaves nothing to type, so the value box goes.
      if (mode.value === 'literal') {
        tail.append(
          valueInput(property, ref.value, (value) => (ref.value = value), { withToggle: true }),
        );
      }
    }

    if (options.withDelay) {
      const delay = document.createElement('input');
      delay.type = 'number';
      delay.className = 'delay';
      delay.min = 0;
      delay.placeholder = 'delay s';
      delay.value = ref.delayMs ? ref.delayMs / 1000 : '';
      delay.addEventListener('input', () => {
        const seconds = Number(delay.value);
        ref.delayMs = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined;
      });
      tail.append(delay);
    }

    if (options.onRemove) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'add-row';
      remove.textContent = '✕';
      remove.title = 'Remove';
      remove.addEventListener('click', options.onRemove);
      tail.append(remove);
    }
  }

  fillProperties();
  redrawTail();
  return row;
}

/** Offers what the property accepts rather than a free text box wherever possible. */
function valueInput(property, current, onChange, options = {}) {
  if (property?.type === 'enum' && property.values?.length) {
    const select = document.createElement('select');
    for (const value of property.values) {
      const choice = document.createElement('option');
      choice.value = value;
      choice.textContent = value;
      select.append(choice);
    }
    select.value = current ?? property.values[0];
    onChange(select.value);
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }

  if (property?.type === 'binary') {
    const select = document.createElement('select');
    const choices = [property.onValue ?? 'ON', property.offValue ?? 'OFF'];
    // Only when the device says it understands one, and only as something to
    // send. A device never reports that it is toggling.
    if (options.withToggle && property.toggleValue !== undefined) {
      choices.push(property.toggleValue);
    }
    for (const value of choices) {
      const choice = document.createElement('option');
      choice.value = String(value);
      choice.textContent = String(value);
      select.append(choice);
    }
    select.value = current !== undefined && current !== '' ? String(current) : select.options[0].value;
    onChange(select.value);
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }

  const input = document.createElement('input');
  input.type = property?.type === 'numeric' ? 'number' : 'text';
  if (property?.min !== undefined) {
    input.min = property.min;
  }
  if (property?.max !== undefined) {
    input.max = property.max;
  }
  input.value = current ?? '';
  input.addEventListener('input', () => {
    onChange(input.type === 'number' ? Number(input.value) : input.value);
  });
  return input;
}

function renderLog() {
  el.log.replaceChildren();
  if (state.log.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Nothing has run yet.';
    el.log.append(empty);
    return;
  }
  for (const entry of state.log.slice(0, 50)) {
    const line = document.createElement('div');
    line.className = `log-line ${entry.outcome}`;
    const when = document.createElement('span');
    when.className = 'log-time';
    when.textContent = new Date(entry.at).toLocaleTimeString();
    const what = document.createElement('span');
    what.textContent = `${entry.ruleName}: ${OUTCOME_LABELS[entry.outcome] ?? entry.outcome}, ${entry.detail}`;
    line.append(when, what);
    el.log.append(line);
  }
}

function showView(view) {
  state.view = view;
  el.viewDevices.hidden = view !== 'devices';
  el.viewRules.hidden = view !== 'rules';
  el.tabDevices.classList.toggle('active', view === 'devices');
  el.tabRules.classList.toggle('active', view === 'rules');
  if (view === 'rules') {
    loadRules().catch((problem) => setStatus(problem.message, 'lost'));
  }
}

el.tabDevices.addEventListener('click', () => showView('devices'));
el.tabRules.addEventListener('click', () => showView('rules'));

el.addRule.addEventListener('click', async () => {
  const trigger = { ...blankRef(watchable), match: { kind: 'changedTo', value: '' } };
  const draft = {
    name: 'New rule',
    enabled: false,
    trigger,
    conditions: [],
    actions: [{ ...blankRef(writable), value: '' }],
  };
  try {
    const created = await api('/api/rules', { method: 'PUT', body: JSON.stringify(draft) });
    state.openRules.add(created.rule.id);
    await loadRules();
  } catch (problem) {
    setStatus(problem.message, 'lost');
  }
});
