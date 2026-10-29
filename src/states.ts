import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

import type { AdapterEvents, SourceAdapter } from './adapters/types.js';
import type { Logger } from './logger.js';
import { LOCAL_PREFIX, type MqttConnection, type MqttMessage } from './mqtt/client.js';
import type { NormalisedDevice, NormalisedProperty } from './model/types.js';
import type { StateToggle, StateType, Store } from './store.js';

/** The source every state toggle belongs to. Not a source id anybody can configure. */
export const STATES_SOURCE = 'states';

/** What an action sends to flip a toggle rather than set it. */
export const TOGGLE_VALUE = 'toggle';

/** What a state starts at, and goes back to when its type changes. */
const STARTS_AT: Record<StateType, boolean | number> = {
  boolean: false,
  number: 0,
};

const TOPIC = `${LOCAL_PREFIX}${STATES_SOURCE}`;

/**
 * The states, as a source of devices.
 *
 * Each one is a device with one function, a truth or a number, that rules
 * can read and write and HomeKit never sees. Written the way any device is: a
 * rule publishes to its set topic, which is a local one, so the publish comes
 * straight back here instead of going to the broker. Nothing else in the
 * plugin needs to know a toggle is not a device.
 */
export class StateToggles extends EventEmitter<AdapterEvents> implements SourceAdapter {
  readonly sourceId = STATES_SOURCE;
  /** The name is the toggle's own, kept with its value. */
  readonly providesNames = true;

  private unsubscribe?: () => void;

  constructor(
    private readonly store: Store,
    private readonly mqtt: MqttConnection,
    private readonly log: Logger,
  ) {
    super();
  }

  async start(): Promise<void> {
    this.unsubscribe = this.mqtt.subscribe(`${TOPIC}/+/set`, (message) => this.written(message));
    this.emit('devices', this.getDevices());
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  getDevices(): NormalisedDevice[] {
    return this.store.data.states.map((toggle) => ({
      sourceId: STATES_SOURCE,
      deviceId: toggle.id,
      name: toggle.name,
      properties: [property(toggle)],
    }));
  }

  getState(deviceId: string): Readonly<Record<string, unknown>> | undefined {
    const toggle = this.find(deviceId);
    return toggle ? { state: toggle.value } : undefined;
  }

  find(id: string): StateToggle | undefined {
    return this.store.data.states.find((toggle) => toggle.id === id);
  }

  /** A new one, at its type's starting value until something says otherwise. */
  create(name: string, type: StateType = 'boolean'): StateToggle {
    let id: string;
    do {
      id = randomBytes(4).toString('hex');
    } while (this.find(id));

    const toggle: StateToggle = { id, name, type, value: STARTS_AT[type] };
    this.store.update((state) => {
      state.states.push(toggle);
    });
    this.emit('devices', this.getDevices());
    return toggle;
  }

  rename(id: string, name: string): boolean {
    const toggle = this.find(id);
    if (!toggle) {
      return false;
    }
    if (toggle.name !== name) {
      this.store.update(() => {
        toggle.name = name;
      });
      this.emit('devices', this.getDevices());
    }
    return true;
  }

  /**
   * Makes it hold another kind of value, starting again from that kind's
   * starting value: true has no meaning as a number.
   */
  retype(id: string, type: StateType): boolean {
    const toggle = this.find(id);
    if (!toggle) {
      return false;
    }
    if (toggle.type === type) {
      return true;
    }
    this.store.update(() => {
      toggle.type = type;
    });
    this.emit('devices', this.getDevices());
    this.set(id, STARTS_AT[type]);
    return true;
  }

  /**
   * Sets one, and says so only when that changed it.
   *
   * Read the way its type reads a value, so `"true"` sets a truth and `7.9`
   * sets the number 7. Something it cannot hold changes nothing and answers
   * false. A state has nobody to report back but itself, so true set to true
   * is not news the way a lamp repeating that it is on would be.
   */
  set(id: string, raw: unknown, byHand = false): boolean {
    const toggle = this.find(id);
    if (!toggle) {
      return false;
    }
    const value = readValue(toggle.type, raw, toggle.value);
    if (value === undefined) {
      return false;
    }
    if (toggle.value === value) {
      return true;
    }
    this.store.update(() => {
      toggle.value = value;
    });
    this.emit('state', {
      sourceId: STATES_SOURCE,
      deviceId: id,
      changes: { state: value },
      at: Date.now(),
      retained: false,
      ...(byHand ? { byHand: true } : {}),
    });
    return true;
  }

  /**
   * Removes a toggle and where it was put.
   *
   * Rules that used it are left as they are, the way they are when a device
   * leaves the network: they say what is missing and skip it.
   */
  remove(id: string): boolean {
    if (!this.find(id)) {
      return false;
    }
    this.store.update((state) => {
      state.states = state.states.filter((toggle) => toggle.id !== id);
      delete state.exposures[`${STATES_SOURCE}:${id}`];
    });
    this.emit('devices', this.getDevices());
    return true;
  }

  /** Reads the toggles again, after a settings file replaced them. */
  reload(): void {
    this.emit('devices', this.getDevices());
  }

  private written(message: MqttMessage): void {
    const id = message.topic.slice(TOPIC.length + 1, -'/set'.length);
    const toggle = this.find(id);
    if (!toggle) {
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(message.payload.toString());
    } catch {
      payload = undefined;
    }
    const raw = (payload as { state?: unknown } | undefined)?.state;
    if (!this.set(id, raw)) {
      const holds = toggle.type === 'boolean' ? 'true or false' : `a ${toggle.type}`;
      this.log.warn(`${toggle.name} holds ${holds}, not ${JSON.stringify(raw)}`);
    }
  }
}

function property(toggle: StateToggle): NormalisedProperty {
  const common = {
    key: 'state',
    label: 'State',
    access: { readable: true, writable: true },
    category: 'primary' as const,
    stateTopic: `${TOPIC}/${toggle.id}`,
    setTopic: `${TOPIC}/${toggle.id}/set`,
    extract: ['state'],
  };
  if (toggle.type === 'number') {
    return { ...common, type: 'numeric', step: 1 };
  }
  return {
    ...common,
    semantic: 'state',
    type: 'binary',
    onValue: true,
    offValue: false,
    toggleValue: TOGGLE_VALUE,
  };
}

/**
 * What a write asks for, however it was worded.
 *
 * A rule sends `true`, or `"true"` from a value typed in, or whatever a lamp
 * said when a mirror or a copied trigger restates it. A number loses its
 * fraction.
 */
function readValue(
  type: StateType,
  raw: unknown,
  current: boolean | number,
): boolean | number | undefined {
  if (type === 'number') {
    const number =
      typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
    return Number.isFinite(number) ? Math.trunc(number) : undefined;
  }
  if (typeof raw === 'boolean') {
    return raw;
  }
  const word = String(raw).trim().toLowerCase();
  if (word === TOGGLE_VALUE) {
    return !current;
  }
  if (['true', 'on', '1'].includes(word)) {
    return true;
  }
  if (['false', 'off', '0'].includes(word)) {
    return false;
  }
  return undefined;
}
