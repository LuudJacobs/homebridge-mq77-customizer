import { EventEmitter } from 'node:events';

import type { Logger } from '../../logger.js';
import type { MqttConnection } from '../../mqtt/client.js';
import { joinTopic } from '../../mqtt/topics.js';
import { isPlainObject } from '../../model/payload.js';
import type { NormalisedDevice, NormalisedProperty, StateUpdate } from '../../model/types.js';
import type { AdapterContext, AdapterEvents, SourceAdapter, SourceConfig } from '../types.js';
import { inferType, KNOWN_KEYS, labelFor } from './keys.js';

/** How long to wait for the broker's retained messages before complaining. */
const UNMATCHED_AFTER_MS = 15_000;

interface Tracked {
  deviceId: string;
  topic: string;
  /** Built up over time, since one message rarely carries every key. */
  properties: Map<string, NormalisedProperty>;
  state: Record<string, unknown>;
  /**
   * Declared functions this device has not yet reported.
   *
   * A declaration has to guess how a value is written, since there is no
   * sample to look at. The first real one settles it.
   */
  unconfirmed: Set<string>;
  /** Whether the last message on this topic was one the broker had kept. */
  retained?: boolean;
}

/**
 * Reads publishers that put flat JSON on a topic per device.
 *
 * There is no schema to discover, so properties are inferred from the keys
 * seen, accumulated across messages rather than taken from the first one. A
 * partial update carrying only `speed` must not redefine the accessory.
 */
export class JsonTopicAdapter extends EventEmitter<AdapterEvents> implements SourceAdapter {
  readonly sourceId: string;
  /** Devices are named after their topic, which is rarely what a human wants. */
  readonly providesNames = false;

  private readonly source: SourceConfig;
  private readonly mqtt: MqttConnection;
  private readonly log: Logger;
  private readonly base: string;
  private readonly setSuffix?: string;
  /** Functions named in the config, by device topic. */
  private readonly declared = new Map<string, string[]>();

  private readonly tracked = new Map<string, Tracked>();
  private readonly unsubscribes: (() => void)[] = [];
  private unmatchedCheck?: ReturnType<typeof setTimeout>;

  constructor(context: AdapterContext) {
    super();
    this.sourceId = context.source.id;
    this.source = context.source;
    this.mqtt = context.mqtt;
    this.log = context.log;
    this.base = context.source.baseTopic.replace(/\/+$/, '');
    this.setSuffix = context.source.setTopicSuffix?.replace(/^\/+/, '') || undefined;

    for (const device of context.source.devices ?? []) {
      const topic = this.relative(device.topic);
      const keys = device.properties
        .map((property) => property.trim().toLowerCase())
        .filter(Boolean);
      if (topic && keys.length > 0) {
        this.declared.set(topic, keys);
      }
    }
  }

  /**
   * The device part of a topic, however it was written.
   *
   * The config asks for the part under the base topic, but the whole topic is
   * the obvious thing to paste and used to be ignored without a word, which
   * looks exactly like the feature not working.
   */
  private relative(topic: string): string {
    const trimmed = topic.trim().replace(/^\/+|\/+$/g, '');
    return trimmed.startsWith(`${this.base}/`) ? trimmed.slice(this.base.length + 1) : trimmed;
  }

  async start(): Promise<void> {
    const filter = this.source.topics ?? joinTopic(this.base, '#');
    this.unsubscribes.push(
      this.mqtt.subscribe(filter, (message) => {
        this.handle(message.topic, message.payload, message.retained);
      }),
    );
    this.log.info(
      this.setSuffix
        ? `Watching ${filter}, commands on <topic>/${this.setSuffix}`
        : `Watching ${filter}, read only`,
    );

    // Said out loud, so a topic written in a way that matches nothing is
    // visible in the log rather than looking like nothing happened.
    for (const [topic, keys] of this.declared) {
      this.log.info(`Described ${joinTopic(this.base, topic)}: ${keys.join(', ')}`);
    }

    if (this.declared.size > 0) {
      // Long enough for the broker to have replayed what it retains. A
      // description naming a topic nothing reports on does nothing at all,
      // and one letter out from a real topic looks entirely correct.
      this.unmatchedCheck = setTimeout(() => this.reportUnmatched(), UNMATCHED_AFTER_MS);
      this.unmatchedCheck.unref?.();
    }
  }

  async stop(): Promise<void> {
    for (const unsubscribe of this.unsubscribes.splice(0)) {
      unsubscribe();
    }
    clearTimeout(this.unmatchedCheck);
    this.unmatchedCheck = undefined;
  }

  /** Names any described topic nothing has turned up on, and what did. */
  private reportUnmatched(): void {
    const missing = [...this.declared.keys()].filter((topic) => !this.tracked.has(topic));
    if (missing.length === 0) {
      return;
    }

    const seen = [...this.tracked.keys()];
    this.log.warn(
      `Nothing has reported on ${missing.map((topic) => joinTopic(this.base, topic)).join(', ')}, ` +
        `described in the config. ` +
        (seen.length > 0
          ? `Seen on this source: ${seen.map((topic) => joinTopic(this.base, topic)).join(', ')}`
          : 'Nothing at all has reported on this source.'),
    );
  }

  getDevices(): NormalisedDevice[] {
    return [...this.tracked.values()].map((entry) => ({
      sourceId: this.sourceId,
      deviceId: entry.deviceId,
      name: entry.deviceId,
      topic: entry.topic,
      manufacturer: this.source.id,
      model: 'JSON topic',
      // Nothing here holds the publisher's settings, so the only answer is
      // the one the broker gave: whether what we last heard was a replay.
      retained: entry.retained,
      properties: [...entry.properties.values()],
    }));
  }

  getState(deviceId: string): Readonly<Record<string, unknown>> | undefined {
    return this.tracked.get(deviceId)?.state;
  }

  private handle(topic: string, payload: Buffer, retained: boolean): void {
    const relative = topic.startsWith(`${this.base}/`)
      ? topic.slice(this.base.length + 1)
      : topic;

    // Our own commands come back on the wildcard subscription.
    if (this.setSuffix && relative.endsWith(`/${this.setSuffix}`)) {
      return;
    }

    // An empty payload is how MQTT says a retained topic is finished with, so
    // clearing one takes the device out of the catalog rather than leaving it
    // until the next restart.
    if (payload.length === 0) {
      if (this.tracked.delete(relative)) {
        this.log.info(`${relative} was cleared from the broker, dropping it`);
        this.emit('devices', this.getDevices());
      }
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.toString());
    } catch {
      this.log.debug(`Ignoring non JSON payload on ${topic}`);
      return;
    }
    if (!isPlainObject(parsed)) {
      this.log.debug(`Ignoring non object payload on ${topic}`);
      return;
    }

    const entry = this.tracked.get(relative) ?? {
      deviceId: relative,
      topic,
      properties: new Map<string, NormalisedProperty>(),
      state: {},
      unconfirmed: new Set<string>(),
    };
    const isNew = !this.tracked.has(relative);
    const wasRetained = entry.retained;
    entry.retained = retained;
    this.tracked.set(relative, entry);

    if (isNew) {
      this.addDeclared(entry);
    }

    let discovered = false;
    const changes: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(parsed)) {
      // A declared function was described without a sample to go on, so the
      // first real value replaces the guess: a publisher using true and false
      // must not be sent "ON".
      if (entry.unconfirmed.delete(key)) {
        const observed = this.describe(key, value, topic);
        if (observed) {
          entry.properties.set(key, observed);
        }
      }

      const property = entry.properties.get(key) ?? this.describe(key, value, topic);
      if (!property) {
        continue;
      }
      if (!entry.properties.has(key)) {
        entry.properties.set(key, property);
        discovered = true;
      }
      changes[key] = value;
      entry.state[key] = value;
    }

    if (isNew || discovered || wasRetained !== retained) {
      this.log.info(
        `${relative}: ${entry.properties.size} propert${entry.properties.size === 1 ? 'y' : 'ies'}`,
      );
      this.emit('devices', this.getDevices());
    }

    if (Object.keys(changes).length > 0) {
      // A publisher that says when it spoke is taken at its word, the same as
      // Zigbee2MQTT is. Nothing here can say it on the publisher's behalf.
      const reported = (parsed as { last_seen?: unknown }).last_seen;

      const update: StateUpdate = {
        sourceId: this.sourceId,
        deviceId: relative,
        changes,
        at: Date.now(),
        retained,
        ...(typeof reported === 'string' || typeof reported === 'number'
          ? { reportedLastSeen: reported }
          : {}),
      };
      this.emit('state', update);
    }
  }

  /**
   * Adds the functions the config says this device has.
   *
   * Only keys the adapter already understands, since a name on its own says
   * nothing about what kind of value it carries.
   */
  private addDeclared(entry: Tracked): void {
    const added: string[] = [];

    for (const key of this.declared.get(entry.deviceId) ?? []) {
      if (entry.properties.has(key)) {
        continue;
      }
      if (!KNOWN_KEYS[key]) {
        this.log.warn(
          `${entry.deviceId}: cannot declare "${key}", no known meaning for it. ` +
            `Known: ${Object.keys(KNOWN_KEYS).join(', ')}`,
        );
        continue;
      }
      // No sample to read the on and off values from, so assume the strings
      // this publisher family uses and correct it when one arrives.
      const property = this.describe(key, KNOWN_KEYS[key]!.type === 'binary' ? 'ON' : 0, entry.topic);
      if (property) {
        entry.properties.set(key, property);
        entry.unconfirmed.add(key);
        added.push(key);
      }
    }

    if (added.length > 0) {
      this.log.info(`${entry.deviceId}: added ${added.join(', ')} from the config`);
    }
  }

  private describe(key: string, value: unknown, topic: string): NormalisedProperty | undefined {
    const known = KNOWN_KEYS[key];
    const type = known?.type ?? inferType(value);
    if (!type) {
      this.log.debug(`Ignoring ${key} on ${topic}, no usable value type`);
      return undefined;
    }

    // Without a command topic nothing here can be written, whatever the key
    // would otherwise allow.
    const writable = Boolean(this.setSuffix) && (known?.writable ?? false);

    const property: NormalisedProperty = {
      key,
      label: known?.label ?? labelFor(key),
      semantic: key,
      type,
      access: { readable: true, writable },
      category: known ? 'primary' : 'diagnostic',
      unit: known?.unit,
      min: known?.min,
      max: known?.max,
      stateTopic: topic,
      setTopic: writable ? `${topic}/${this.setSuffix}` : undefined,
      extract: [key],
    };

    if (type === 'binary') {
      // Publishers differ on whether on/off is a string or a boolean, and we
      // have to send back whatever this one uses.
      const boolean = typeof value === 'boolean';
      property.onValue = boolean ? true : 'ON';
      property.offValue = boolean ? false : 'OFF';
    }

    return property;
  }
}

export function createJsonTopicAdapter(context: AdapterContext): SourceAdapter {
  return new JsonTopicAdapter(context);
}
