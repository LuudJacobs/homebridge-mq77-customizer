import { EventEmitter } from 'node:events';

import type { Logger } from '../../logger.js';
import type { MqttConnection } from '../../mqtt/client.js';
import { joinTopic } from '../../mqtt/topics.js';
import { isPlainObject } from '../../model/payload.js';
import type { NormalisedDevice, NormalisedProperty, StateUpdate } from '../../model/types.js';
import type { AdapterContext, AdapterEvents, SourceAdapter, SourceConfig } from '../types.js';
import { inferType, KNOWN_KEYS, labelFor } from './keys.js';

interface Tracked {
  deviceId: string;
  topic: string;
  /** Built up over time, since one message rarely carries every key. */
  properties: Map<string, NormalisedProperty>;
  state: Record<string, unknown>;
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

  private readonly source: SourceConfig;
  private readonly mqtt: MqttConnection;
  private readonly log: Logger;
  private readonly base: string;
  private readonly setSuffix?: string;

  private readonly tracked = new Map<string, Tracked>();
  private readonly unsubscribes: (() => void)[] = [];

  constructor(context: AdapterContext) {
    super();
    this.sourceId = context.source.id;
    this.source = context.source;
    this.mqtt = context.mqtt;
    this.log = context.log;
    this.base = context.source.baseTopic.replace(/\/+$/, '');
    this.setSuffix = context.source.setTopicSuffix?.replace(/^\/+/, '') || undefined;
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
  }

  async stop(): Promise<void> {
    for (const unsubscribe of this.unsubscribes.splice(0)) {
      unsubscribe();
    }
  }

  getDevices(): NormalisedDevice[] {
    return [...this.tracked.values()].map((entry) => ({
      sourceId: this.sourceId,
      deviceId: entry.deviceId,
      name: entry.deviceId,
      manufacturer: this.source.id,
      model: 'JSON topic',
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
    };
    const isNew = !this.tracked.has(relative);
    this.tracked.set(relative, entry);

    let discovered = false;
    const changes: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(parsed)) {
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

    if (isNew || discovered) {
      this.log.info(
        `${relative}: ${entry.properties.size} propert${entry.properties.size === 1 ? 'y' : 'ies'}`,
      );
      this.emit('devices', this.getDevices());
    }

    if (Object.keys(changes).length > 0) {
      const update: StateUpdate = {
        sourceId: this.sourceId,
        deviceId: relative,
        changes,
        at: Date.now(),
        retained,
      };
      this.emit('state', update);
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
