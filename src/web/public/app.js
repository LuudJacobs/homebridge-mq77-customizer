// Deliberately dependency free and unbuilt, so it can be edited in place on
// the Pi and reloaded without a toolchain.

const state = {
  devices: [],
  tileTypes: [],
  filter: '',
  /** Hides everything that is not currently published to HomeKit. */
  exposedOnly: false,
  /** Hides rules that are switched off. */
  enabledOnly: false,
  /** Which kinds the activity list shows. */
  activityKinds: { standard: true, mirror: true, slider: true, timer: true, action: true },
  // Kept per tab, so switching away and back does not lose what was typed and
  // a device filter never silently applies to a rule list.
  filters: { devices: '', automation: '', mirror: '', activity: '' },
  sorts: { devices: 'name', automation: 'name', mirror: 'name', sliders: 'name', timers: 'name' },
  /**
   * A rule just added, kept at the top of its list.
   *
   * It is saved the moment it is added, so sorting would otherwise drop it
   * somewhere down the page under the name it has not been given yet.
   */
  pinned: undefined,
  /** The last network scan, and whether one is running. */
  map: undefined,
  scanning: false,
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
  enabledOnly: document.getElementById('enabled-only'),
  onlyExposed: document.getElementById('only-exposed'),
  onlyEnabled: document.getElementById('only-enabled'),
  kindFilters: document.getElementById('kind-filters'),
  kindAutomation: document.getElementById('kind-automation'),
  kindMirror: document.getElementById('kind-mirror'),
  kindSlider: document.getElementById('kind-slider'),
  kindTimer: document.getElementById('kind-timer'),
  kindAction: document.getElementById('kind-action'),
  sort: document.getElementById('sort'),
  logout: document.getElementById('logout'),
  tabDevices: document.getElementById('tab-devices'),
  tabAutomation: document.getElementById('tab-automation'),
  tabMirror: document.getElementById('tab-mirror'),
  tabSliders: document.getElementById('tab-sliders'),
  tabTimers: document.getElementById('tab-timers'),
  tabActivity: document.getElementById('tab-activity'),
  tabMap: document.getElementById('tab-map'),
  viewDevices: document.getElementById('view-devices'),
  viewAutomation: document.getElementById('view-automation'),
  viewMirror: document.getElementById('view-mirror'),
  viewSliders: document.getElementById('view-sliders'),
  viewTimers: document.getElementById('view-timers'),
  viewActivity: document.getElementById('view-activity'),
  viewMap: document.getElementById('view-map'),
  map: document.getElementById('map'),
  mapStatus: document.getElementById('map-status'),
  scanMap: document.getElementById('scan-map'),
  mapTip: document.getElementById('map-tip'),
  automation: document.getElementById('automation'),
  mirror: document.getElementById('mirror'),
  sliders: document.getElementById('sliders'),
  timers: document.getElementById('timers'),
  activityLog: document.getElementById('activity-log'),
  addAutomation: document.getElementById('add-automation'),
  addMirror: document.getElementById('add-mirror'),
  addSlider: document.getElementById('add-slider'),
  addTimer: document.getElementById('add-timer'),
  zigbee2mqttLink: document.getElementById('zigbee2mqtt-link'),
  build: document.getElementById('build'),
};

const key = (device) => `${device.sourceId}:${device.deviceId}`;

/** What the device is called here: the given name, or the source's own. */
/**
 * What a device is called here.
 *
 * A name of its own wins, with the room in front of it when both are set.
 * A room on its own does not change the name: it is there for grouping, and
 * a device called "Kitchen" in Zigbee2MQTT would otherwise read "Kitchen
 * Kitchen".
 */
/**
 * What a device is called here, said for the room being read.
 *
 * Under a heading the room comes off the devices that are in it, since the
 * heading has said it. Anything from elsewhere keeps its room: a remote in
 * the living room switching a kitchen light is listed under Kitchen, and
 * which remote it is matters.
 */
const displayName = (device, inRoom) => {
  const name = device.exposure.label?.trim();
  const room = device.exposure.room?.trim();
  if (!name) {
    return device.name;
  }
  if (!room || (inRoom !== undefined && room === inRoom)) {
    return name;
  }
  return `${room} ${name}`;
};

const DEVICE_TYPES = [
  ['', 'Not set'],
  ['light', 'Light'],
  ['sensor', 'Sensor'],
  ['controller', 'Controller'],
  ['fan', 'Fan'],
  ['tv', 'TV'],
  ['audio', 'Audio device'],
  ['media', 'Media device'],
  ['other', 'Other'],
];

/**
 * A small drawing for the kind of thing a device is.
 *
 * Drawn here rather than fetched: the page is self contained and reaches
 * nothing outside itself.
 */
/** One fan blade, from the hub outwards. Turned to make the other two. */
const BLADE = 'M12 12C12 8 13 5.4 15.1 5.4c1.8 0 2.7 2.1 1.2 3.8C15 10.6 13.6 11.6 12 12Z';

const TYPE_PATHS = {
  light: [
    'M12 3a6 6 0 0 0-4 10.5c.6.6 1 1.4 1 2.2V17h6v-1.3c0-.8.4-1.6 1-2.2A6 6 0 0 0 12 3Z',
    'M9 18h6M10 21h4',
  ],
  sensor: ['M10 14.8V5a2 2 0 1 1 4 0v9.8a4 4 0 1 1-4 0Z', 'M12 17.5v-4'],
  // A wall switch: a plate with a rocker in it.
  controller: [
    'M7 2.5h10a1.5 1.5 0 0 1 1.5 1.5v16a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 20V4A1.5 1.5 0 0 1 7 2.5Z',
    'M9.5 7h5v10h-5Z',
    'M9.5 12h5',
  ],
  // One blade, turned twice. A ring with spokes in it read as a steering
  // wheel, which is what a fan drawn that way always looks like.
  fan: [
    { d: BLADE },
    { d: BLADE, rotate: 120 },
    { d: BLADE, rotate: 240 },
    'M12 10.7a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z',
  ],
  tv: [
    'M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z',
    'M12 17v4M8 21h8',
  ],
  audio: ['M4 9.5h3.5L12 6v12l-4.5-3.5H4Z', 'M15.5 9.5a4 4 0 0 1 0 5', 'M18 7a7.5 7.5 0 0 1 0 10'],
  // A receiver: a wide box with a display and two knobs.
  media: [
    'M3 7h18a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z',
    'M5 10.5h6v3H5Z',
    'M15.6 13.2a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4Z',
    'M19.1 13.2a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4Z',
  ],
  other: [
    'M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM5 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM19 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
    'M12 8v4M12 12l-5 4M12 12l5 4',
  ],
};

function typeIcon(device) {
  const type = device.exposure.type;
  if (!type || !TYPE_PATHS[type]) {
    return undefined;
  }
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `type-icon ${type}`);
  svg.setAttribute('aria-hidden', 'true');
  for (const drawing of TYPE_PATHS[type]) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', typeof drawing === 'string' ? drawing : drawing.d);
    if (typeof drawing !== 'string' && drawing.rotate) {
      path.setAttribute('transform', `rotate(${drawing.rotate} 12 12)`);
    }
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
  }
  const title = document.createElementNS(SVG, 'title');
  title.textContent = DEVICE_TYPES.find(([value]) => value === type)?.[1] ?? type;
  svg.append(title);
  return svg;
}

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

  // A released build shows its version, anything else the branch it came from.
  el.build.textContent = snapshot.build ?? '';

  // Only shown when configured, so the tab bar does not carry a dead link.
  const zigbee2mqtt = snapshot.links?.zigbee2mqtt;
  el.zigbee2mqttLink.hidden = !zigbee2mqtt;
  if (zigbee2mqtt) {
    el.zigbee2mqttLink.href = zigbee2mqtt;
  }
  showApp();
  paintControls();
  safeRender();
}

/**
 * A rendering fault must not look like a failed sign in.
 *
 * Letting it throw would unwind into the sign in handler, which would send the
 * user back to the login form with a misleading message.
 */
function safeRender() {
  safely(render);
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
      if (showsRules()) {
        loadRules().catch(() => {});
      }
      return;
    }
    if (payload.type === 'log') {
      state.log.unshift(payload.entry);
      state.log = state.log.slice(0, 200);
      if (showsRules()) {
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
  room: (device) => device.exposure.room?.trim() ?? '',
  type: (device) => device.exposure.type ?? '',
};

/** The heading a device belongs under, when the list is grouped. */
const GROUP_KEYS = {
  room: (device) => device.exposure.room?.trim() ?? '',
  type: (device) =>
    DEVICE_TYPES.find(([value]) => value === device.exposure.type)?.[1] ?? '',
};

/** Devices with nothing set go under this, at the end. */
const UNGROUPED = 'Unknown';

/**
 * Splits a list into headed groups, keeping the order it came in.
 *
 * Anything with nothing to group by goes last under one heading, rather than
 * being sorted in among the named ones under an empty title.
 */
function intoGroups(items, headingOf) {
  const groups = new Map();
  for (const item of items) {
    const heading = headingOf(item) || UNGROUPED;
    if (!groups.has(heading)) {
      groups.set(heading, []);
    }
    groups.get(heading).push(item);
  }
  return [...groups.entries()].sort(
    ([a], [b]) =>
      Number(a === UNGROUPED) - Number(b === UNGROUPED) || compareNames(a, b),
  );
}

function groupHeading(text) {
  const heading = document.createElement('h3');
  heading.className = 'rule-group';
  heading.textContent = text;
  return heading;
}

/** What each tab offers, and what it says it is filtering. */
const TAB_CONTROLS = {
  devices: {
    sorts: [
      ['name', 'Name'],
      ['room', 'Room'],
      ['type', 'Type'],
      ['topic', 'Topic'],
      ['device', 'Device'],
      ['seen', 'Last seen'],
    ],
    placeholder: 'Filter...',
  },
  automation: {
    sorts: [
      ['name', 'Name'],
      ['room', 'Room'],
      ['trigger', 'Trigger device'],
    ],
    placeholder: 'Filter...',
  },
  mirror: {
    sorts: [
      ['name', 'Name'],
      ['room', 'Room'],
    ],
    placeholder: 'Filter...',
  },
  sliders: {
    sorts: [
      ['name', 'Name'],
      ['room', 'Room'],
    ],
    placeholder: 'Filter...',
  },
  timers: {
    sorts: [
      ['name', 'Name'],
      ['room', 'Room'],
      ['trigger', 'Trigger device'],
    ],
    placeholder: 'Filter...',
  },
  activity: { sorts: [], placeholder: 'Filter...' },
  map: { sorts: [], placeholder: 'Filter...' },
};

/** Points the header controls at whatever the current tab is about. */
function paintControls() {
  const view = state.view;
  const controls = TAB_CONTROLS[view];
  const rules =
    view === 'automation' || view === 'mirror' || view === 'sliders' || view === 'timers';

  el.onlyExposed.hidden = view !== 'devices';
  el.onlyEnabled.hidden = !rules;
  el.kindFilters.hidden = view !== 'activity';

  el.sort.hidden = controls.sorts.length === 0;
  if (controls.sorts.length > 0) {
    el.sort.replaceChildren();
    for (const [value, label] of controls.sorts) {
      const choice = document.createElement('option');
      choice.value = value;
      choice.textContent = label;
      el.sort.append(choice);
    }
    el.sort.value = state.sorts[view] ?? 'name';
  }

  // Nothing on the map is filtered or sorted from up here.
  el.filter.hidden = view === 'map';
  el.filter.placeholder = controls.placeholder;
  el.filter.value = state.filters[view] ?? '';
}

const currentFilter = () => (state.filters[state.view] ?? '').trim().toLowerCase();

function sortDevices(devices) {
  const sorted = [...devices];

  if (state.sorts.devices === 'seen') {
    // Newest first, and anything that has said nothing yet goes last rather
    // than pretending to be very old.
    return sorted.sort((a, b) => (deviceLastSeen(b) ?? -1) - (deviceLastSeen(a) ?? -1));
  }

  const key = SORT_KEYS[state.sorts.devices] ?? SORT_KEYS.name;
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
    device.exposure.room,
    device.topic,
    device.model,
    device.manufacturer,
    device.deviceId,
  ]
    .filter(Boolean)
    .some((field) => field.toLowerCase().includes(term));
}

function render() {
  const term = currentFilter();
  const visible = sortDevices(
    state.devices.filter(
      (device) => matchesFilter(device, term) && (!state.exposedOnly || exposedCount(device) > 0),
    ),
  );

  el.devices.replaceChildren();

  const grouping = GROUP_KEYS[state.sorts.devices];
  if (grouping && visible.length > 0) {
    // Only a room heading has said the room. Grouping by kind has not.
    const byRoom = state.sorts.devices === 'room';
    for (const [heading, devices] of intoGroups(visible, grouping)) {
      el.devices.append(groupHeading(heading));
      for (const device of devices) {
        el.devices.append(renderDevice(device, byRoom ? heading : undefined));
      }
    }
    return;
  }

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

function renderDevice(device, inRoom) {
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
  name.textContent = displayName(device, inRoom);
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
  const icon = typeIcon(device);
  if (icon) {
    summary.append(icon);
  }
  summary.append(name, meta, seen, topic, badge);
  card.append(summary);

  const body = document.createElement('div');
  body.className = 'device-body';

  body.append(renderDeviceInfo(device, name));

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
 * Name, room and kind, for grouping and reading in this interface.
 *
 * None of it reaches HomeKit, which keeps rooms in the Home app where no
 * accessory can set or read them. The name is the exception, and only where
 * the source names nothing itself.
 */
function renderDeviceInfo(device, heading) {
  const row = document.createElement('div');
  row.className = 'device-info';

  const repaint = () => {
    heading.textContent = displayName(device);
    save(device);
    // The icon lives in the header, which is not redrawn on its own.
    safeRender();
  };

  const field = (label, value, placeholder, onChange) => {
    const wrap = document.createElement('label');
    wrap.className = 'device-field';
    wrap.append(document.createTextNode(label));
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value ?? '';
    input.placeholder = placeholder;
    input.maxLength = 64;
    input.addEventListener('change', () => onChange(input.value.trim()));
    wrap.append(input);
    return wrap;
  };

  row.append(
    field('Name', device.exposure.label, device.name, (value) => {
      device.exposure.label = value || undefined;
      repaint();
    }),
  );
  row.append(
    field('Room', device.exposure.room, 'none', (value) => {
      device.exposure.room = value || undefined;
      repaint();
    }),
  );

  const typeWrap = document.createElement('label');
  typeWrap.className = 'device-field';
  typeWrap.append(document.createTextNode('Type'));
  const type = document.createElement('select');
  for (const [value, label] of DEVICE_TYPES) {
    const choice = document.createElement('option');
    choice.value = value;
    choice.textContent = label;
    type.append(choice);
  }
  type.value = device.exposure.type ?? '';
  type.addEventListener('change', () => {
    device.exposure.type = type.value || undefined;
    repaint();
  });
  typeWrap.append(type);
  row.append(typeWrap);

  return row;
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
  state.filters[state.view] = el.filter.value;
  repaint();
});

el.sort.addEventListener('change', () => {
  state.sorts[state.view] = el.sort.value;
  repaint();
});

el.exposedOnly.addEventListener('change', () => {
  state.exposedOnly = el.exposedOnly.checked;
  safeRender();
});

el.enabledOnly.addEventListener('change', () => {
  state.enabledOnly = el.enabledOnly.checked;
  renderRules();
});

el.kindAutomation.addEventListener('change', () => {
  state.activityKinds.standard = el.kindAutomation.checked;
  renderLog();
});

el.kindMirror.addEventListener('change', () => {
  state.activityKinds.mirror = el.kindMirror.checked;
  renderLog();
});

el.kindSlider.addEventListener('change', () => {
  state.activityKinds.slider = el.kindSlider.checked;
  renderLog();
});

el.kindTimer.addEventListener('change', () => {
  state.activityKinds.timer = el.kindTimer.checked;
  renderLog();
});

el.kindAction.addEventListener('change', () => {
  state.activityKinds.action = el.kindAction.checked;
  renderLog();
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
  skipped: 'nothing to do',
  started: 'started',
  cancelled: 'called off',
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

/** Whether a stored rule belongs to the mirror tab or the automation one. */
const kindOf = (rule) => {
  if (rule.kind === 'mirror' || rule.kind === 'slider' || rule.kind === 'timer') {
    return rule.kind;
  }
  return 'standard';
};

function renderRules() {
  safely(() => renderRuleList('standard', el.automation, 'No automations yet.'));
  safely(() => renderRuleList('mirror', el.mirror, 'No mirrored devices yet.'));
  safely(() => renderRuleList('slider', el.sliders, 'No sliders yet.'));
  safely(() => renderRuleList('timer', el.timers, 'No timers yet.'));
}

/**
 * Keeps one rule the interface cannot read from blanking the tab.
 *
 * Sorting and filtering both walk every rule, so a single rule in a shape
 * this build does not understand used to take the whole list down with it,
 * and silently: an empty tab looks exactly like having no rules.
 */
function safely(render) {
  try {
    render();
  } catch (error) {
    console.error('Rendering failed', error);
    setStatus(`display error: ${error.message}`, 'lost');
  }
}

/** The devices a rule touches, in the order it names them. */
/**
 * Every trigger of a rule, whatever shape it was saved in.
 *
 * `trigger` is what versions before outcomes stored, a single one, and rules
 * written back then are still on disk unchanged.
 */
function ruleTriggers(rule) {
  if (rule.triggers?.length) {
    return rule.triggers;
  }
  return rule.trigger ? [rule.trigger] : [];
}

/** Every action of a rule, across all of its outcomes. */
function ruleActions(rule) {
  if (rule.branches?.length) {
    return rule.branches.flatMap((branch) => branch.actions ?? []);
  }
  return rule.actions ?? [];
}

function ruleRefs(rule) {
  if (rule.kind === 'mirror') {
    return (rule.groups ?? []).flat();
  }
  if (rule.kind === 'slider') {
    const buttons = ['up', 'down', 'on', 'off'].flatMap((key) =>
      Array.isArray(rule[key]) ? rule[key] : [rule[key]],
    );
    return [rule.target, ...buttons].filter(Boolean);
  }
  return [...ruleTriggers(rule), ...ruleActions(rule)];
}

/** First device on each side, which is what the two orderings compare. */
function ruleSides(rule) {
  if (rule.kind === 'mirror') {
    const refs = ruleRefs(rule);
    return { trigger: refs[0], target: refs[1] };
  }
  if (rule.kind === 'slider') {
    // The device being driven is what a slider is about, whichever button
    // happens to be set.
    const first = (key) => (Array.isArray(rule[key]) ? rule[key][0] : rule[key]);
    return { trigger: first('up') ?? first('on'), target: rule.target };
  }
  return { trigger: ruleTriggers(rule)[0], target: ruleActions(rule)[0] };
}

/**
 * The devices a rule acts on, which is not the same as the ones that set it
 * off. What a rule does is where it matters: a button in the hall turning on
 * a lamp in the study is a study rule.
 */
function affectedRefs(rule) {
  if (rule.kind === 'mirror') {
    // Every member is both sides of a mirror, so all of them are affected.
    return (rule.groups ?? []).flat().filter(Boolean);
  }
  if (rule.kind === 'slider') {
    return [rule.target].filter(Boolean);
  }
  return ruleActions(rule);
}

/** The rooms a rule reaches, in order, with unplaced devices passed over. */
function affectedRooms(rule) {
  const rooms = new Set();
  for (const ref of affectedRefs(rule)) {
    const room = findDevice(ref)?.exposure?.room?.trim();
    if (room) {
      rooms.add(room);
    }
  }
  return [...rooms].sort(compareNames);
}

/**
 * A rule's name, said with the rooms it reaches in front of it.
 *
 * Left off under a room heading, which has already said it, and off entirely
 * for a rule that reaches nowhere named.
 */
function ruleTitle(rule, grouped = false) {
  const rooms = affectedRooms(rule);
  // Left off only when the heading has said all of it. A rule reaching two
  // rooms still says so under either, since the other room is news.
  if (rooms.length === 0 || (grouped && rooms.length === 1)) {
    return rule.name;
  }
  return `${rooms.join(' / ')}: ${rule.name}`;
}

function ruleSortKey(rule, sort) {
  if (sort === 'room') {
    return affectedRooms(rule)[0] || '\uffff';
  }
  if (sort === 'trigger' || sort === 'target') {
    const ref = ruleSides(rule)[sort];
    const device = ref && findDevice(ref);
    // A rule pointing at a device that has gone sorts last rather than first.
    return device ? displayName(device) : '\uffff';
  }
  return rule.name;
}

function matchesRuleFilter(rule, term) {
  if (!term) {
    return true;
  }
  if (rule.name.toLowerCase().includes(term)) {
    return true;
  }
  // Also by the devices it touches, so a rule can be found from the thing it
  // acts on rather than only from what it was called.
  return ruleRefs(rule).some((ref) => {
    const device = ref && findDevice(ref);
    return (
      device &&
      [
        displayName(device),
        device.name,
        device.exposure?.room,
        device.topic,
        device.model,
        device.manufacturer,
      ]
        .filter(Boolean)
        .some((field) => field.toLowerCase().includes(term))
    );
  });
}

function renderRuleList(kind, container, emptyText) {
  container.replaceChildren();
  const term = currentFilter();
  const sort = state.sorts[state.view] ?? 'name';

  // A rule just added is exempt from both. It is saved the moment it is
  // added, so it starts with a placeholder name and switched off, and a list
  // that was filtered or set to enabled only would swallow it on the spot.
  const justAdded = (rule) => rule.id === state.pinned;

  const rules = state.rules
    .filter((rule) => kindOf(rule) === kind)
    .filter((rule) => justAdded(rule) || !state.enabledOnly || rule.enabled)
    .filter((rule) => justAdded(rule) || matchesRuleFilter(rule, term))
    .sort(
      (a, b) =>
        // A rule just added stays in sight, wherever its name would put it.
        Number(b.id === state.pinned) - Number(a.id === state.pinned) ||
        compareNames(ruleSortKey(a, sort), ruleSortKey(b, sort)) ||
        compareNames(ruleTitle(a), ruleTitle(b)),
    );

  if (rules.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = state.rules.some((rule) => kindOf(rule) === kind)
      ? 'Nothing matches.'
      : emptyText;
    container.append(empty);
    return;
  }

  // Sorting automations by trigger is really a question about a remote: what
  // does each of its buttons do. That reads better as a list per device than
  // as one long list in trigger order.
  if ((kind === 'standard' || kind === 'timer') && sort === 'trigger') {
    renderByTrigger(container, rules);
    return;
  }

  // By room means by the rooms a rule acts in, which is where somebody is
  // standing when they wonder what runs there. A rule reaching two rooms is
  // listed under both, since it is the answer in both. Kind is not offered
  // here: what runs on the lights is not a question anybody asks.
  if (sort === 'room') {
    const groups = new Map();
    for (const rule of rules) {
      const rooms = affectedRooms(rule);
      for (const room of rooms.length > 0 ? rooms : [UNGROUPED]) {
        if (!groups.has(room)) {
          groups.set(room, []);
        }
        groups.get(room).push(rule);
      }
    }

    const ordered = [...groups.entries()].sort(
      ([a], [b]) => Number(a === UNGROUPED) - Number(b === UNGROUPED) || compareNames(a, b),
    );

    for (const [heading, grouped] of ordered) {
      container.append(groupHeading(heading));
      for (const rule of grouped) {
        container.append(renderRule(rule, undefined, heading === UNGROUPED ? '' : heading));
      }
    }
    return;
  }

  for (const rule of rules) {
    container.append(renderRule(rule));
  }
}

/** What a trigger waits for, as a phrase: "Action becomes 1_single". */
function describeTrigger(trigger) {
  if (!trigger) {
    return 'Nothing yet';
  }
  const label = findProperty(trigger)?.label ?? trigger.propertyKey ?? 'something';
  const verb = MATCH_KINDS.find((entry) => entry.kind === trigger.match?.kind)?.label ?? '';
  const value = trigger.match?.value;
  const hasValue = value !== undefined && value !== '';
  return [label, verb, hasValue ? value : ''].filter(Boolean).join(' ');
}

/**
 * A heading per trigger device, and a line under it per trigger.
 *
 * A rule set off by three buttons appears three times, which is the point: the
 * list answers what a given button does, not what a given rule is called.
 */
function renderByTrigger(container, rules) {
  const groups = new Map();

  for (const rule of rules) {
    // A rule just added has nothing set yet, so it goes above the headings
    // rather than under one for whichever device happened to be first.
    if (rule.id === state.pinned) {
      container.append(renderRule(rule));
      continue;
    }

    const triggers = ruleTriggers(rule);
    for (const [index, trigger] of (triggers.length ? triggers : [undefined]).entries()) {
      const device = trigger && findDevice(trigger);
      const key = device ? `${device.sourceId}|${device.deviceId}` : '';
      if (!groups.has(key)) {
        groups.set(key, {
          name: device ? displayName(device) : 'No device',
          known: Boolean(device),
          entries: [],
        });
      }
      groups.get(key).entries.push({ rule, trigger, index });
    }
  }

  // Devices by name, and anything whose device has gone at the end.
  const ordered = [...groups.values()].sort(
    (a, b) => Number(b.known) - Number(a.known) || compareNames(a.name, b.name),
  );

  for (const group of ordered) {
    const heading = document.createElement('h3');
    heading.className = 'rule-group';
    heading.textContent = group.name;
    container.append(heading);

    group.entries.sort(
      (a, b) =>
        compareNames(describeTrigger(a.trigger), describeTrigger(b.trigger)) ||
        compareNames(a.rule.name, b.rule.name),
    );
    for (const entry of group.entries) {
      container.append(renderRule(entry.rule, entry));
    }
  }
}

function renderRule(rule, occurrence, inRoom) {
  const card = document.createElement('details');
  card.className = 'device rule';
  // One rule can be listed under several of its triggers, and opening it in
  // one place should not open it in the others.
  const key = occurrence ? `${rule.id}#${occurrence.index}` : rule.id;
  card.open = state.openRules.has(key);
  card.addEventListener('toggle', () => {
    if (card.open) {
      state.openRules.add(key);
    } else {
      state.openRules.delete(key);
    }
  });

  const summary = document.createElement('summary');
  const name = document.createElement('span');
  name.className = 'device-name';
  // Only a room heading has said the room. A heading naming the device that
  // sets a rule off has said nothing about where the rule acts.
  name.textContent = ruleTitle(rule, inRoom !== undefined);
  const detail = document.createElement('span');
  detail.className = 'device-meta';
  // Under a trigger heading the rule is named first and what sets it off
  // second, since the heading has already said which device it is.
  if (occurrence) {
    detail.textContent = describeTrigger(occurrence.trigger);
  } else {
    detail.replaceChildren(...summarise(rule, inRoom));
  }
  const badge = document.createElement('span');
  badge.className = rule.enabled ? 'badge' : 'badge none';
  badge.textContent = rule.enabled ? 'on' : 'off';
  summary.append(name, detail, badge);
  card.append(summary);

  card.append(renderRuleBody(rule));
  return card;
}

/** A device as it is named here, with its kind drawn in front of it. */
function deviceParts(ref, suffix = '', inRoom) {
  // A device or a reference to one, since the log already holds the device.
  const device = ref && (ref.properties ? ref : findDevice(ref));
  if (!device) {
    return [document.createTextNode(`a removed device${suffix}`)];
  }
  const icon = typeIcon(device);
  const text = document.createTextNode(`${displayName(device, inRoom)}${suffix}`);
  return icon ? [icon, text] : [text];
}

/** A wait as somebody would say it: "30s", "2m", "1m 30s". */
function describeWait(waitMs) {
  const total = Math.round((waitMs ?? 0) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/** " (+2)" when a rule reaches more than one device on that side. */
const andMore = (count) => (count > 1 ? ` (+${count - 1})` : '');

/** The devices a list of refs touches, counted once each. */
function distinctDevices(refs) {
  return new Set(refs.filter(Boolean).map((ref) => `${ref.sourceId}|${ref.deviceId}`)).size;
}

/** The line under a rule's name, saying what it works on. Returns nodes. */
/**
 * The line under a rule's name, saying which devices it works on.
 *
 * Devices only: which function of a lamp a rule writes is in the rule, and
 * repeating "state" on every line said nothing anybody was reading for.
 */
function summarise(rule, inRoom) {
  const words = (text) => document.createTextNode(text);

  if (rule.kind === 'slider') {
    const buttons = ['up', 'down', 'on', 'off'].filter((key) =>
      Array.isArray(rule[key]) ? rule[key].length > 0 : Boolean(rule[key]),
    ).length;
    return [
      ...deviceParts(rule.target, '', inRoom),
      words(` · ${rule.steps ?? 5} steps · ${buttons} button${buttons === 1 ? '' : 's'}`),
    ];
  }

  if (rule.kind === 'mirror') {
    const seen = new Set();
    const parts = [];
    for (const ref of (rule.groups ?? []).flat()) {
      const id = `${ref.sourceId}|${ref.deviceId}`;
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      if (parts.length > 0) {
        parts.push(words(' ↔ '));
      }
      parts.push(...deviceParts(ref, '', inRoom));
    }
    const fields = rule.groups?.length ?? 0;
    parts.push(words(` · ${fields} field${fields === 1 ? '' : 's'}`));
    return parts;
  }

  const triggers = ruleTriggers(rule);
  const actions = ruleActions(rule);
  const outcomes = rule.branches?.length ?? 1;

  return [
    ...deviceParts(triggers[0], andMore(distinctDevices(triggers)), inRoom),
    words(rule.kind === 'timer' ? ` → ${describeWait(rule.waitMs)} → ` : ' → '),
    ...deviceParts(actions[0], andMore(distinctDevices(actions)), inRoom),
    words(outcomes > 1 && rule.kind !== 'timer' ? ` - ${outcomes} outcomes` : ''),
  ];
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

  nameRow.append(enabled);
  body.append(nameRow);

  // The tab a rule lives in settles what it is, so there is nothing to choose
  // here. Changing a rule from one to the other means making the other one.
  const shape = document.createElement('div');
  if (draft.kind === 'mirror') {
    drawMirror(shape, draft);
  } else if (draft.kind === 'slider') {
    drawSlider(shape, draft);
  } else if (draft.kind === 'timer') {
    drawTimer(shape, draft);
  } else {
    drawWhenThen(shape, draft);
  }

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
      // Saved, so it has a name worth sorting by and can take its place.
      if (state.pinned === rule.id) {
        state.pinned = undefined;
      }
      await loadRules();
    } catch (problem) {
      error.textContent = problem.message;
    }
  });

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'danger';
  remove.textContent = 'Delete';

  const erase = async () => {
    await api(`/api/rules/${encodeURIComponent(rule.id)}`, { method: 'DELETE' }).catch(() => {});
    state.openRules.delete(rule.id);
    await loadRules();
  };

  // A rule that has only just been added is a blank nobody has written
  // anything into, so asking twice is in the way. Anything else took work.
  if (rule.id === state.pinned) {
    remove.addEventListener('click', erase);
  } else {
    let armed;
    remove.addEventListener('click', () => {
      if (armed) {
        clearTimeout(armed);
        armed = undefined;
        return erase();
      }
      remove.textContent = 'Confirm';
      remove.classList.add('armed');
      // Long enough to mean it, short enough that a button left saying
      // Confirm cannot be pressed by mistake later.
      armed = setTimeout(() => {
        armed = undefined;
        remove.textContent = 'Delete';
        remove.classList.remove('armed');
      }, CONFIRM_MS);
    });
  }

  footer.append(save, error, remove);
  return footer;
}

/** The ordinary trigger, conditions and actions form. */
function drawWhenThen(body, draft) {
  // A rule stored before this carries one trigger. Read it as a list of one.
  draft.triggers = draft.triggers?.length
    ? draft.triggers
    : [draft.trigger ?? { ...blankRef(watchable), match: { kind: 'changedTo', value: '' } }];
  delete draft.trigger;
  draft.actions = draft.actions?.length ? draft.actions : [{ ...blankRef(writable), value: '' }];

  body.append(sectionTitle('When'));

  const triggers = document.createElement('div');
  triggers.className = 'triggers';
  const drawTriggers = () => {
    triggers.replaceChildren();
    draft.triggers.forEach((trigger, index) => {
      const last = index === draft.triggers.length - 1;
      triggers.append(
        refRow(trigger, {
          pick: watchable,
          withMatch: true,
          // Any of them fires the rule, so the last one cannot be removed.
          onRemove:
            draft.triggers.length > 1
              ? () => {
                  draft.triggers.splice(index, 1);
                  drawTriggers();
                }
              : undefined,
          // Nothing joining them: the heading says what the run of rows is
          // for, and any of them fires the rule.
          trailing: last
            ? addButton('+ trigger', () => {
                draft.triggers.push({
                  ...blankRef(watchable),
                  match: { kind: 'changedTo', value: '' },
                });
                drawTriggers();
              })
            : undefined,
        }),
      );
    });
  };
  drawTriggers();
  body.append(triggers);
  // One outcome or several. The first branch that holds runs, so else if is
  // exclusive by construction rather than by carefully written conditions.
  draft.branches = draft.branches?.length
    ? draft.branches
    : [{ when: draft.when, conditions: draft.conditions, actions: draft.actions }];
  delete draft.when;
  delete draft.conditions;
  delete draft.actions;

  const branches = document.createElement('div');
  const drawBranches = () => {
    branches.replaceChildren();
    draft.branches.forEach((branch, index) => {
      branches.append(renderBranch(branch, index, draft.branches, drawBranches));
    });
    branches.append(
      addButton('Add outcome', () => {
        draft.branches.push({ actions: [{ ...blankRef(writable), value: '' }] });
        drawBranches();
      }),
    );
  };
  drawBranches();
  body.append(branches);
}

/** One outcome: what has to hold, and what to do when it does. */
function renderBranch(branch, index, branches, redraw) {
  const box = document.createElement('div');
  box.className = 'branch';

  const only = branches.length === 1;

  const head = document.createElement('div');
  head.className = 'branch-head';

  const left = document.createElement('div');
  left.className = 'branch-head-left';
  left.append(sectionTitle(index === 0 ? 'And, optionally' : 'Or when'));
  // Where the condition editor puts its add button while there is nothing to
  // show, since there is no row for it to sit on yet.
  const slot = document.createElement('span');
  left.append(slot);
  head.append(left);

  const right = document.createElement('div');
  right.className = 'branch-head-right';

  // Says what this outcome is for. Nothing reads it, it is there so a rule
  // with three outcomes can still be understood next year.
  const name = document.createElement('input');
  name.type = 'text';
  name.className = 'outcome-name';
  name.placeholder = 'name';
  name.value = branch.label ?? '';
  name.addEventListener('input', () => {
    branch.label = name.value.trim() || undefined;
  });
  right.append(name);

  if (!only) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'add-row';
    remove.textContent = '✕';
    remove.title = `Remove outcome ${index + 1}`;
    remove.addEventListener('click', () => {
      branches.splice(index, 1);
      redraw();
    });
    right.append(remove);
  }

  head.append(right);

  box.append(head);
  box.append(conditionEditor(branch, slot));

  box.append(sectionTitle('Then'));
  box.append(actionEditor(branch));
  return box;
}

function actionEditor(branch) {
  const wrap = document.createElement('div');
  wrap.className = 'actions';
  branch.actions = branch.actions?.length ? branch.actions : [{ ...blankRef(writable), value: '' }];

  const draw = () => {
    wrap.replaceChildren();
    branch.actions.forEach((action, index) => {
      const last = index === branch.actions.length - 1;
      wrap.append(
        refRow(action, {
          pick: writable,
          withValue: true,
          withDelay: true,
          onRemove:
            branch.actions.length > 1
              ? () => {
                  branch.actions.splice(index, 1);
                  draw();
                }
              : undefined,
          trailing: last
            ? addButton('+ action', () => {
                branch.actions.push({ ...blankRef(writable), value: '' });
                draw();
              })
            : undefined,
        }),
      );
    });
  };

  draw();
  return wrap;
}

/**
 * Pick the devices, then the functions to keep in step.
 *
 * Functions are matched on meaning rather than on name: a socket calls its
 * on/off `state` and a two channel switch calls the same thing `state_l1`, and
 * mirroring one onto the other is exactly what this is for.
 */
/** Levels a slider can drive: a number the device will take. */
const slidable = (device) =>
  device.properties.filter((property) => property.writable && property.type === 'numeric');

/** The on/off of the same device, which is what the ends of the range need. */
function powerOf(ref) {
  const device = ref && findDevice(ref);
  const power = device?.properties.find(
    (property) => property.role === 'power' && property.writable,
  );
  return power ? { sourceId: ref.sourceId, deviceId: ref.deviceId, propertyKey: power.key } : undefined;
}

function drawTimer(body, draft) {
  draft.triggers = draft.triggers?.length
    ? draft.triggers
    : [{ ...blankRef(watchable), match: { kind: 'changedTo', value: '' } }];
  draft.actions = draft.actions?.length ? draft.actions : [{ ...blankRef(writable), value: '' }];
  draft.waitMs = draft.waitMs ?? 30_000;

  body.append(sectionTitle('When'));

  const triggers = document.createElement('div');
  triggers.className = 'triggers';
  const drawTriggers = () => {
    triggers.replaceChildren();
    draft.triggers.forEach((trigger, index) => {
      const last = index === draft.triggers.length - 1;
      triggers.append(
        refRow(trigger, {
          pick: watchable,
          withMatch: true,
          // Any of them starts the clock, so the last cannot be removed.
          onRemove:
            draft.triggers.length > 1
              ? () => {
                  draft.triggers.splice(index, 1);
                  drawTriggers();
                }
              : undefined,
          trailing: last
            ? addButton('+ trigger', () => {
                draft.triggers.push({
                  ...blankRef(watchable),
                  match: { kind: 'changedTo', value: '' },
                });
                drawTriggers();
              })
            : undefined,
        }),
      );
    });
  };
  drawTriggers();
  body.append(triggers);

  body.append(sectionTitle('Wait'));
  const waitRow = document.createElement('div');
  waitRow.className = 'option';

  const total = Math.round(draft.waitMs / 1000);
  const minutesLabel = document.createElement('label');
  minutesLabel.textContent = 'Minutes';
  const minutes = document.createElement('input');
  minutes.type = 'number';
  minutes.className = 'delay';
  minutes.min = 0;
  minutes.value = Math.floor(total / 60);

  const secondsLabel = document.createElement('label');
  secondsLabel.textContent = 'Seconds';
  const seconds = document.createElement('input');
  seconds.type = 'number';
  seconds.className = 'delay';
  seconds.min = 0;
  seconds.max = 59;
  seconds.value = total % 60;

  const readWait = () => {
    const both = (Number(minutes.value) || 0) * 60 + (Number(seconds.value) || 0);
    // A timer of nothing is an automation, and there is a tab for those.
    draft.waitMs = Math.max(1, both) * 1000;
  };
  minutes.addEventListener('input', readWait);
  seconds.addEventListener('input', readWait);

  waitRow.append(minutesLabel, minutes, secondsLabel, seconds);
  body.append(waitRow);

  body.append(sectionTitle('Then'));
  body.append(actionEditor(draft));
}

function drawSlider(body, draft) {
  draft.target = draft.target?.propertyKey ? draft.target : blankRef(slidable);
  draft.power = draft.power ?? powerOf(draft.target);
  draft.steps = draft.steps ?? 5;

  const hint = document.createElement('p');
  hint.className = 'hint';

  /** What the device itself comes on at, when it keeps such a setting. */
  const deviceOnLevel = () => {
    const device = findDevice(draft.target);
    const property = device?.properties.find((candidate) => candidate.key.endsWith('on_level'));
    const value = property && device.state?.[property.key];
    return typeof value === 'number' ? value : undefined;
  };

  const describeLadder = () => {
    const property = findProperty(draft.target);
    if (!property) {
      hint.textContent = 'Pick something with a level to drive.';
      return;
    }
    const fromDevice = deviceOnLevel();
    onLevel.placeholder = fromDevice === undefined ? 'first step' : String(fromDevice);
    const min = property.min ?? 0;
    const top = Math.min(draft.max ?? property.max ?? 100, property.max ?? 100);
    const size = Math.round((top - min) / draft.steps);
    const ladder = `${draft.steps} steps of about ${size}, from ${min} to ${top}.`;
    const landing = draft.onLevel ?? fromDevice;
    const coming =
      landing === undefined
        ? 'Comes on at the first step.'
        : draft.onLevel === undefined
          ? `Comes on at ${landing}, which is what the device is set to.`
          : `Comes on at ${landing}.`;
    hint.textContent = draft.power
      ? `${ladder} ${coming} Off is a step of its own.`
      : `${ladder} Nothing on this device switches on and off, so the ends cannot.`;
  };

  const targetRow = document.createElement('div');
  targetRow.className = 'option';
  const targetLabel = document.createElement('label');
  targetLabel.textContent = 'Device';
  targetRow.append(targetLabel);
  targetRow.append(
    refRow(draft.target, {
      pick: slidable,
      onChange: () => {
        // The switch belongs to whichever device is being driven.
        draft.power = powerOf(draft.target);
        describeLadder();
      },
    }),
  );
  body.append(targetRow);

  const settings = document.createElement('div');
  settings.className = 'option';

  const stepsLabel = document.createElement('label');
  stepsLabel.textContent = 'Steps';
  const steps = document.createElement('input');
  steps.type = 'number';
  steps.className = 'delay';
  steps.min = 2;
  steps.max = 20;
  steps.value = draft.steps;
  steps.addEventListener('input', () => {
    const count = Number(steps.value);
    draft.steps = Number.isFinite(count) && count >= 2 ? Math.round(count) : 5;
    describeLadder();
  });

  const maxLabel = document.createElement('label');
  maxLabel.textContent = 'Highest';
  const max = document.createElement('input');
  max.type = 'number';
  max.className = 'delay';
  max.placeholder = 'device max';
  max.value = draft.max ?? '';
  max.addEventListener('input', () => {
    const ceiling = Number(max.value);
    draft.max = max.value !== '' && Number.isFinite(ceiling) ? ceiling : undefined;
    describeLadder();
  });

  const onLevelLabel = document.createElement('label');
  onLevelLabel.textContent = 'On at';
  const onLevel = document.createElement('input');
  onLevel.type = 'number';
  onLevel.className = 'delay';
  onLevel.value = draft.onLevel ?? '';
  onLevel.addEventListener('input', () => {
    const level = Number(onLevel.value);
    draft.onLevel = onLevel.value !== '' && Number.isFinite(level) ? level : undefined;
    describeLadder();
  });

  settings.append(stepsLabel, steps, maxLabel, max, onLevelLabel, onLevel);
  body.append(settings, hint);
  describeLadder();

  const buttons = document.createElement('div');
  const drawButtons = () => {
    buttons.replaceChildren();
    for (const [key, label] of [
      ['up', 'Step up'],
      ['down', 'Step down'],
      ['on', 'Switch on'],
      ['off', 'Switch off'],
    ]) {
      // Stored as a list. A slider written before that carries one, which is
      // read as a list of one and written back as such on the next save.
      draft[key] = Array.isArray(draft[key]) ? draft[key] : draft[key] ? [draft[key]] : [];
      const triggers = draft[key];

      buttons.append(sectionTitle(label));

      const add = () => {
        triggers.push({ ...blankRef(watchable), match: { kind: 'changedTo', value: '' } });
        drawButtons();
      };

      if (triggers.length === 0) {
        buttons.append(addButton('+ trigger', add));
        continue;
      }

      triggers.forEach((trigger, index) => {
        const last = index === triggers.length - 1;
        buttons.append(
          refRow(trigger, {
            pick: watchable,
            withMatch: true,
            onRemove: () => {
              triggers.splice(index, 1);
              drawButtons();
            },
            // No "or" between them: a heading of its own already says what
            // this run of rows is for, and any of them presses it.
            trailing: last ? addButton('+ trigger', add) : undefined,
          }),
        );
      });
    }
  };
  drawButtons();
  body.append(buttons);
}

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

/**
 * Two levels: any of several groups, each all of several tests.
 *
 * Deeper nesting would express nothing new, since every boolean expression can
 * be written as an or of ands, and it would cost a much heavier editor.
 */
function conditionEditor(draft, slot) {
  const wrap = document.createElement('div');
  wrap.className = 'conditions';

  // Stored to any depth, so anything hand written that does not fit two levels
  // is left alone rather than quietly flattened.
  if (draft.when && !isTwoLevel(draft.when)) {
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = `Condition edited by hand: ${draft.when.kind}. Leaving it as it is.`;
    wrap.append(note);
    return wrap;
  }

  // A rule saved before expressions existed still carries a flat list, and the
  // interface is handed rules exactly as stored. Reading only `when` would
  // show it as having no conditions and drop them on the next save.
  const groups = toGroups(draft.when ?? asExpression(draft.conditions));

  const draw = () => {
    wrap.replaceChildren();

    groups.forEach((group, index) => {
      if (index > 0) {
        const or = document.createElement('p');
        or.className = 'joiner';
        or.textContent = 'or';
        wrap.append(or);
      }
      wrap.append(renderGroup(group, groups, index, commit, draw));
    });

    const add = addButton(groups.length === 0 ? '+ condition' : 'Add or', () => {
      groups.push({ negated: false, tests: [newTest()] });
      commit();
      draw();
    });

    // With no conditions set there is no row to hang the button off, so it
    // goes up beside the heading instead of alone on a line of its own.
    slot?.replaceChildren();
    if (groups.length === 0 && slot) {
      slot.append(add);
    } else {
      wrap.append(add);
    }
  };

  function commit() {
    draft.when = fromGroups(groups);
  }

  draw();
  return wrap;
}

function renderGroup(group, groups, index, commit, redraw) {
  const box = document.createElement('div');
  box.className = 'condition-group';

  const head = document.createElement('div');
  head.className = 'group-head';
  const negate = document.createElement('label');
  negate.className = 'toggle';
  const negateBox = document.createElement('input');
  negateBox.type = 'checkbox';
  negateBox.checked = group.negated;
  negateBox.addEventListener('change', () => {
    group.negated = negateBox.checked;
    commit();
  });
  negate.append(negateBox, document.createTextNode('Not'));
  negate.title = 'Holds when this group does not';
  head.append(negate);

  head.append(
    addButton('Remove group', () => {
      groups.splice(index, 1);
      commit();
      redraw();
    }),
  );
  box.append(head);

  group.tests.forEach((node, position) => {
    const last = position === group.tests.length - 1;
    box.append(
      refRow(node, {
        pick: watchable,
        withMatch: true,
        onChange: commit,
        onRemove:
          group.tests.length > 1
            ? () => {
                group.tests.splice(position, 1);
                commit();
                redraw();
              }
            : undefined,
        joiner: last ? undefined : 'and',
        trailing: last
          ? addButton('+ condition', () => {
              group.tests.push(newTest());
              commit();
              redraw();
            })
          : undefined,
      }),
    );
  });

  return box;
}

function newTest() {
  return { kind: 'test', ...blankRef(watchable), match: { kind: 'equals', value: '' } };
}

/** Reads what earlier versions stored, a flat list meaning all of them. */
function asExpression(conditions) {
  if (!conditions?.length) {
    return undefined;
  }
  return { kind: 'all', nodes: conditions.map((condition) => ({ kind: 'test', ...condition })) };
}

/** True when the stored expression is something this editor can show. */
function isTwoLevel(when) {
  const groupish = (node) =>
    node.kind === 'test' ||
    (node.kind === 'not' && groupish(node.node)) ||
    (node.kind === 'all' && node.nodes.every((child) => child.kind === 'test'));

  if (when.kind === 'any') {
    return when.nodes.every(groupish);
  }
  return groupish(when);
}

/** Reads the stored expression into the rows the editor works with. */
function toGroups(when) {
  if (!when) {
    return [];
  }
  const asGroup = (node) => {
    if (node.kind === 'not') {
      return { ...asGroup(node.node), negated: true };
    }
    if (node.kind === 'all') {
      return { negated: false, tests: node.nodes.map((child) => structuredClone(child)) };
    }
    return { negated: false, tests: [structuredClone(node)] };
  };
  return when.kind === 'any' ? when.nodes.map(asGroup) : [asGroup(when)];
}

/** And back again, in the simplest form that says the same thing. */
function fromGroups(groups) {
  const nodes = groups
    .filter((group) => group.tests.length > 0)
    .map((group) => {
      const inner = group.tests.length === 1 ? group.tests[0] : { kind: 'all', nodes: group.tests };
      return group.negated ? { kind: 'not', node: inner } : inner;
    });

  if (nodes.length === 0) {
    return undefined;
  }
  return nodes.length === 1 ? nodes[0] : { kind: 'any', nodes };
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
  // Wider than the rest of the row, since a device name is the longest thing
  // on it and the one worth reading at a glance. Not `device`, which is the
  // card a device is drawn in and would style this like one.
  devices.className = 'device-picker';
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

  const changed = () => options.onChange?.();

  devices.addEventListener('change', () => {
    const [sourceId, deviceId] = devices.value.split('|');
    ref.sourceId = sourceId;
    ref.deviceId = deviceId;
    ref.propertyKey = '';
    fillProperties();
    redrawTail();
    changed();
  });
  properties.addEventListener('change', () => {
    ref.propertyKey = properties.value;
    redrawTail();
    changed();
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
        changed();
      });
      tail.append(kinds);

      if (ref.match.kind !== 'changed') {
        // No toggle here: it is something to send, never something a device
        // reports, so it could never match.
        tail.append(
          valueInput(property, ref.match.value, (value) => {
            ref.match.value = value;
            changed();
          }),
        );
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
          valueInput(
            property,
            ref.value,
            (value) => {
              ref.value = value;
              changed();
            },
            { withToggle: true },
          ),
        );
      }
    }

    if (options.withDelay) {
      const delay = document.createElement('input');
      delay.type = 'number';
      delay.className = 'delay';
      delay.min = 0;
      delay.placeholder = 'delay (s)';
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

    // The word joining this row to the next one, and the button that adds
    // another, both belong on this line rather than on one of their own.
    if (options.joiner) {
      const joiner = document.createElement('span');
      joiner.className = 'joiner inline';
      joiner.textContent = options.joiner;
      tail.append(joiner);
    }

    if (options.trailing) {
      tail.append(options.trailing);
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

const KIND_LABELS = {
  standard: 'automation',
  mirror: 'mirror',
  slider: 'slider',
  timer: 'timer',
  action: 'action',
};

function renderLog() {
  const container = el.activityLog;
  container.replaceChildren();
  const term = (state.filters.activity ?? '').trim().toLowerCase();

  const entries = state.log
    .filter((entry) => state.activityKinds[entry.ruleKind ?? 'standard'])
    .filter((entry) => !term || entry.ruleName.toLowerCase().includes(term));

  if (entries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = state.log.length === 0 ? 'Nothing has run yet.' : 'Nothing matches.';
    container.append(empty);
    return;
  }

  for (const entry of entries.slice(0, 100)) {
    const line = document.createElement('div');
    line.className = `log-line ${entry.outcome}`;
    const when = document.createElement('span');
    when.className = 'log-time';
    when.textContent = new Date(entry.at).toLocaleTimeString();
    // Both kinds share this list now, and two rules can share a name, so each
    // entry says which it came from.
    const kind = document.createElement('span');
    kind.className = 'tag';
    kind.textContent = KIND_LABELS[entry.ruleKind ?? 'standard'];

    const what = document.createElement('span');
    if (entry.ruleKind === 'action') {
      // Not a rule: a device saying a button was pressed. Named and drawn the
      // way it is everywhere else, which is not what the engine stored.
      const [sourceId, deviceId] = entry.ruleId.split(':');
      const device = findDevice({ sourceId, deviceId });
      what.replaceChildren(
        ...(device
          ? deviceParts(device, ` → ${entry.detail}`)
          : [document.createTextNode(`${entry.ruleName} → ${entry.detail}`)]),
      );
    } else {
      const rule = state.rules.find((candidate) => candidate.id === entry.ruleId);
      const named = rule ? ruleTitle(rule) : entry.ruleName;
      what.textContent = `${named} - ${OUTCOME_LABELS[entry.outcome] ?? entry.outcome} → ${entry.detail}`;
    }
    line.append(when, kind, what);
    container.append(line);
  }
}

function repaint() {
  if (state.view === 'devices') {
    safeRender();
  } else if (state.view === 'activity') {
    renderLog();
  } else {
    renderRules();
  }
}

const SVG = 'http://www.w3.org/2000/svg';
/** Room for one device box, and the gaps around it. */
const NODE_WIDTH = 132;
const NODE_HEIGHT = 34;
/** Across, one step per hop away from the hub. */
const COLUMN_STEP = NODE_WIDTH + 64;
/** Down, one step per device sharing a hop. */
const ROW_STEP = NODE_HEIGHT + 20;

/**
 * Works out how far each device sits from the hub.
 *
 * A walk out from the coordinator, taking the strongest link first, so a
 * device hangs off the route it most likely uses rather than the first one
 * the scan happened to mention. Anything the walk never reaches is put on a
 * row of its own at the bottom: it answered the scan but nothing connects it.
 */
function layoutMap(map) {
  const neighbours = new Map(map.nodes.map((node) => [node.address, []]));
  for (const link of map.links) {
    neighbours.get(link.from)?.push({ to: link.to, quality: link.quality });
    neighbours.get(link.to)?.push({ to: link.from, quality: link.quality });
  }

  const root = map.nodes.find((node) => node.kind === 'coordinator') ?? map.nodes[0];
  const depth = new Map();
  const parents = new Map();

  if (root) {
    depth.set(root.address, 0);
    const queue = [root.address];
    while (queue.length > 0) {
      const current = queue.shift();
      const edges = [...(neighbours.get(current) ?? [])].sort((a, b) => b.quality - a.quality);
      for (const edge of edges) {
        if (depth.has(edge.to)) {
          continue;
        }
        depth.set(edge.to, depth.get(current) + 1);
        parents.set(edge.to, current);
        queue.push(edge.to);
      }
    }
  }

  const rows = new Map();
  for (const node of map.nodes) {
    const level = depth.has(node.address) ? depth.get(node.address) : Infinity;
    if (!rows.has(level)) {
      rows.set(level, []);
    }
    rows.get(level).push(node);
  }

  // A hop per column, so the hub is on the left and the network reads out
  // from it. Devices sharing a hop stack down that column.
  const levels = [...rows.keys()].sort((a, b) => a - b);
  const tallest = Math.max(1, ...levels.map((level) => rows.get(level).length));
  const height = tallest * ROW_STEP + ROW_STEP;
  const placed = new Map();

  levels.forEach((level, column) => {
    const nodes = rows.get(level).sort((a, b) => compareNames(a.name, b.name));
    const step = height / (nodes.length + 1);
    nodes.forEach((node, index) => {
      placed.set(node.address, {
        node,
        x: column * COLUMN_STEP + NODE_WIDTH / 2 + 10,
        y: step * (index + 1),
        reached: level !== Infinity,
      });
    });
  });

  return { placed, parents, width: levels.length * COLUMN_STEP + 20, height };
}

/** How long a Delete button stays armed before going back to asking. */
const CONFIRM_MS = 2000;

/** Anything at or above this is a good link, at or below the other a poor one. */
const QUALITY_GOOD = 200;
const QUALITY_POOR = 100;

function qualityClass(quality) {
  if (quality >= QUALITY_GOOD) {
    return 'good';
  }
  return quality <= QUALITY_POOR ? 'poor' : '';
}

/**
 * What a device is, and what it can hear.
 *
 * Link quality belongs here rather than on the lines: a device with six
 * neighbours has six lines crossing each other, and reading one of them means
 * finding the right pixel.
 */
function describeNode(spot, map) {
  const lines = [`${spot.node.kind}, ${spot.node.address}`];
  if (spot.node.failed) {
    lines.push('Did not answer the scan');
  }
  if (!spot.reached) {
    lines.push('Nothing links this to the hub');
  }

  const heard = map.links
    .filter((link) => link.from === spot.node.address || link.to === spot.node.address)
    .map((link) => ({
      other: link.from === spot.node.address ? link.to : link.from,
      quality: link.quality,
    }))
    .sort((a, b) => b.quality - a.quality);

  if (heard.length === 0) {
    lines.push('No links');
  }
  return { lines, heard };
}

/** Closes whatever device panel is open, if any. */
function closeMapTip() {
  el.mapTip.hidden = true;
}

function openMapTip(spot, map, event) {
  const { lines, heard } = describeNode(spot, map);
  el.mapTip.replaceChildren();

  const name = document.createElement('strong');
  name.textContent = spot.node.name;
  el.mapTip.append(name);

  for (const line of lines) {
    const paragraph = document.createElement('p');
    paragraph.textContent = line;
    el.mapTip.append(paragraph);
  }

  if (heard.length > 0) {
    const list = document.createElement('ul');
    for (const entry of heard) {
      const item = document.createElement('li');
      const other = map.nodes.find((node) => node.address === entry.other);
      const strength = document.createElement('strong');
      strength.textContent = String(entry.quality);
      strength.className = qualityClass(entry.quality);
      item.append(document.createTextNode(`${other?.name ?? entry.other} · `), strength);
      list.append(item);
    }
    el.mapTip.append(list);
  }

  // Shown before it is placed, since where it fits depends on how big it is.
  el.mapTip.hidden = false;

  const bounds = el.map.getBoundingClientRect();
  const room = {
    x: el.map.clientWidth - el.mapTip.offsetWidth - 8,
    y: el.map.clientHeight - el.mapTip.offsetHeight - 8,
  };
  // Kept inside the map, so a device near an edge does not open a panel half
  // of which needs scrolling to.
  const left = event.clientX - bounds.left + el.map.scrollLeft + 12;
  const top = event.clientY - bounds.top + el.map.scrollTop + 12;
  el.mapTip.style.left = `${Math.max(8, Math.min(left, room.x + el.map.scrollLeft))}px`;
  el.mapTip.style.top = `${Math.max(8, Math.min(top, room.y + el.map.scrollTop))}px`;
}

function drawMap() {
  el.map.replaceChildren();
  el.scanMap.disabled = state.scanning;
  el.scanMap.textContent = state.scanning ? 'Scanning…' : 'Scan the network';

  if (!state.map) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = state.scanning
      ? 'Asking every device in turn. This takes a few minutes.'
      : 'Nothing scanned yet.';
    el.map.append(empty);
    return;
  }

  const { placed, parents, width, height } = layoutMap(state.map);
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'map-svg');
  svg.setAttribute('role', 'img');

  // Every link faintly, so alternatives are visible, and the route back to
  // the hub solid on top of it.
  for (const link of state.map.links) {
    const from = placed.get(link.from);
    const to = placed.get(link.to);
    if (!from || !to) {
      continue;
    }
    const tree = parents.get(link.to) === link.from || parents.get(link.from) === link.to;
    const line = document.createElementNS(SVG, 'line');
    line.setAttribute('x1', from.x);
    line.setAttribute('y1', from.y);
    line.setAttribute('x2', to.x);
    line.setAttribute('y2', to.y);
    // Colour says how good the link is, weight says whether it is the route
    // this device actually uses to reach the hub.
    line.setAttribute(
      'class',
      ['map-link', tree ? 'route' : '', qualityClass(link.quality)].filter(Boolean).join(' '),
    );
    svg.append(line);
  }

  for (const spot of placed.values()) {
    const group = document.createElementNS(SVG, 'g');
    group.setAttribute('class', `map-node ${spot.node.kind.replace(' ', '-')}`);
    if (!spot.reached) {
      group.classList.add('adrift');
    }
    if (spot.node.failed) {
      group.classList.add('failed');
    }

    const box = document.createElementNS(SVG, 'rect');
    box.setAttribute('x', spot.x - NODE_WIDTH / 2);
    box.setAttribute('y', spot.y - NODE_HEIGHT / 2);
    box.setAttribute('width', NODE_WIDTH);
    box.setAttribute('height', NODE_HEIGHT);
    box.setAttribute('rx', 7);

    const text = document.createElementNS(SVG, 'text');
    text.setAttribute('x', spot.x);
    text.setAttribute('y', spot.y + 4);
    text.setAttribute('text-anchor', 'middle');
    text.textContent = spot.node.name;

    group.addEventListener('click', (event) => {
      // Kept from the closing handler on the page, which would shut the panel
      // in the same click that opened it.
      event.stopPropagation();
      openMapTip(spot, state.map, event);
    });

    group.append(box, text);
    svg.append(group);
  }

  el.map.append(svg, el.mapTip);
  closeMapTip();
}

async function scanNetwork() {
  state.scanning = true;
  el.mapStatus.textContent = 'Scanning. Every device is questioned in turn.';
  drawMap();

  try {
    state.map = await api('/api/map', { method: 'POST' });
    el.mapStatus.textContent = `${state.map.nodes.length} devices, scanned ${formatLastSeen(
      state.map.at,
    )}`;
  } catch (problem) {
    el.mapStatus.textContent = problem.message;
  } finally {
    state.scanning = false;
    drawMap();
  }
}

function showView(view) {
  state.view = view;
  el.viewDevices.hidden = view !== 'devices';
  el.viewAutomation.hidden = view !== 'automation';
  el.viewMirror.hidden = view !== 'mirror';
  el.viewSliders.hidden = view !== 'sliders';
  el.viewTimers.hidden = view !== 'timers';
  el.viewActivity.hidden = view !== 'activity';
  el.viewMap.hidden = view !== 'map';
  el.tabDevices.classList.toggle('active', view === 'devices');
  el.tabAutomation.classList.toggle('active', view === 'automation');
  el.tabMirror.classList.toggle('active', view === 'mirror');
  el.tabSliders.classList.toggle('active', view === 'sliders');
  el.tabTimers.classList.toggle('active', view === 'timers');
  el.tabActivity.classList.toggle('active', view === 'activity');
  el.tabMap.classList.toggle('active', view === 'map');
  paintControls();
  if (view === 'devices') {
    safeRender();
  } else if (view === 'map') {
    // Nothing to fetch: a scan is slow enough that it only happens on asking.
    drawMap();
  } else {
    loadRules().catch((problem) => setStatus(problem.message, 'lost'));
  }
}

const showsRules = () =>
  state.view === 'automation' ||
  state.view === 'mirror' ||
  state.view === 'sliders' ||
  state.view === 'timers' ||
  state.view === 'activity';

el.tabDevices.addEventListener('click', () => showView('devices'));
el.tabAutomation.addEventListener('click', () => showView('automation'));
el.tabMirror.addEventListener('click', () => showView('mirror'));
el.tabSliders.addEventListener('click', () => showView('sliders'));
el.tabTimers.addEventListener('click', () => showView('timers'));
el.tabActivity.addEventListener('click', () => showView('activity'));
el.tabMap.addEventListener('click', () => showView('map'));
el.scanMap.addEventListener('click', () => scanNetwork());

// One device panel at a time, and anywhere else closes it.
document.addEventListener('click', () => closeMapTip());

async function addRule(draft) {
  try {
    const created = await api('/api/rules', { method: 'PUT', body: JSON.stringify(draft) });
    state.openRules.add(created.rule.id);
    state.pinned = created.rule.id;
    await loadRules();
  } catch (problem) {
    setStatus(problem.message, 'lost');
  }
}

el.addAutomation.addEventListener('click', () =>
  addRule({
    name: 'New automation',
    // Off to begin with, so a half built rule cannot fire while it is being
    // filled in.
    enabled: false,
    trigger: { ...blankRef(watchable), match: { kind: 'changedTo', value: '' } },
    conditions: [],
    actions: [{ ...blankRef(writable), value: '' }],
  }),
);

el.addTimer.addEventListener('click', () =>
  addRule({
    name: 'New timer',
    enabled: false,
    kind: 'timer',
    triggers: [{ ...blankRef(watchable), match: { kind: 'changedTo', value: '' } }],
    waitMs: 30_000,
    actions: [{ ...blankRef(writable), value: '' }],
  }),
);

el.addSlider.addEventListener('click', () =>
  addRule({
    name: 'New slider',
    enabled: false,
    kind: 'slider',
    target: blankRef(slidable),
    steps: 5,
  }),
);

el.addMirror.addEventListener('click', () =>
  // Saved without groups would be refused, so it starts as an automation and
  // becomes a mirror once devices are chosen. Nothing to store until then.
  addRule({
    name: 'New mirror',
    enabled: false,
    kind: 'mirror',
    groups: [],
  }),
);
