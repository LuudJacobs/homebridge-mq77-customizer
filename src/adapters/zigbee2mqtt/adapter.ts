import { EventEmitter } from 'node:events';

import type { Logger } from '../../logger.js';
import type { MqttConnection } from '../../mqtt/client.js';
import { joinTopic } from '../../mqtt/topics.js';
import { isMissing, readPath } from '../../model/payload.js';
import type { NormalisedDevice, StateUpdate } from '../../model/types.js';
import type { AdapterContext, AdapterEvents, SourceAdapter, SourceConfig } from '../types.js';
import { flattenExposes } from './exposes.js';
import type { Z2mDevice } from './protocol.js';

/** Topics under `<base>/` that carry bridge traffic rather than device state. */
const BRIDGE_PREFIX = 'bridge';
/** Device topic suffixes that are commands or metadata, not state. */
const NON_STATE_SUFFIXES = ['set', 'get'];

export class Zigbee2mqttAdapter
  extends EventEmitter<AdapterEvents>
  implements SourceAdapter
{
  readonly sourceId: string;

  private readonly source: SourceConfig;
  private readonly mqtt: MqttConnection;
  private readonly log: Logger;
  private readonly base: string;

  private devices: NormalisedDevice[] = [];
  /** friendly_name to deviceId, rebuilt on every catalog update. */
  private topicIndex = new Map<string, string>();
  private readonly states = new Map<string, Record<string, unknown>>();
  private readonly unsubscribes: (() => void)[] = [];

  constructor(context: AdapterContext) {
    super();
    this.sourceId = context.source.id;
    this.source = context.source;
    this.mqtt = context.mqtt;
    this.log = context.log;
    this.base = context.source.baseTopic.replace(/\/+$/, '');
  }

  async start(): Promise<void> {
    // `bridge/devices` is retained, so the catalog arrives as soon as we
    // subscribe and again on every join, rename or removal.
    this.unsubscribes.push(
      this.mqtt.subscribe(joinTopic(this.base, BRIDGE_PREFIX, 'devices'), (message) => {
        this.handleDevices(message.payload);
      }),
    );

    this.unsubscribes.push(
      this.mqtt.subscribe(joinTopic(this.base, BRIDGE_PREFIX, 'state'), (message) => {
        this.handleBridgeState(message.payload);
      }),
    );

    // One wildcard rather than a subscription per device, so renames and joins
    // need no resubscribe, and friendly names containing a slash still work.
    this.unsubscribes.push(
      this.mqtt.subscribe(joinTopic(this.base, '#'), (message) => {
        this.handleDeviceMessage(message.topic, message.payload, message.retained);
      }),
    );

    this.log.info(`Watching ${this.base}/bridge/devices`);
  }

  async stop(): Promise<void> {
    for (const unsubscribe of this.unsubscribes.splice(0)) {
      unsubscribe();
    }
  }

  getDevices(): NormalisedDevice[] {
    return this.devices;
  }

  getState(deviceId: string): Readonly<Record<string, unknown>> | undefined {
    return this.states.get(deviceId);
  }

  private handleDevices(payload: Buffer): void {
    let raw: unknown;
    try {
      raw = JSON.parse(payload.toString());
    } catch (error) {
      this.log.error(`bridge/devices is not valid JSON: ${describe(error)}`);
      return;
    }

    if (!Array.isArray(raw)) {
      this.log.error('bridge/devices did not contain an array');
      return;
    }

    const devices: NormalisedDevice[] = [];
    const index = new Map<string, string>();

    for (const entry of raw as Z2mDevice[]) {
      const device = this.toDevice(entry);
      if (!device) {
        continue;
      }
      devices.push(device);
      index.set(entry.friendly_name, device.deviceId);
    }

    this.devices = devices;
    this.topicIndex = index;

    // Drop state for devices that no longer exist, so removed devices do not
    // linger in the interface.
    for (const deviceId of [...this.states.keys()]) {
      if (!devices.some((device) => device.deviceId === deviceId)) {
        this.states.delete(deviceId);
      }
    }

    const properties = devices.reduce((total, device) => total + device.properties.length, 0);
    this.log.info(`Catalog updated: ${devices.length} devices, ${properties} properties`);
    this.emit('devices', devices);
  }

  private toDevice(entry: Z2mDevice): NormalisedDevice | undefined {
    if (entry.type === 'Coordinator') {
      return undefined;
    }
    if (entry.disabled) {
      this.log.debug(`Skipping disabled device ${entry.friendly_name}`);
      return undefined;
    }

    const exposes = entry.definition?.exposes;
    if (!exposes?.length) {
      this.log.info(
        `Skipping ${entry.friendly_name} (${entry.ieee_address}), Zigbee2MQTT has no definition for it`,
      );
      return undefined;
    }

    const stateTopic = joinTopic(this.base, entry.friendly_name);
    const { properties, unsupported } = flattenExposes(exposes, {
      stateTopic,
      setTopic: joinTopic(stateTopic, 'set'),
    });

    if (unsupported.length > 0) {
      this.log.debug(
        `${entry.friendly_name}: ignored expose types ${unsupported.join(', ')}`,
      );
    }

    return {
      sourceId: this.sourceId,
      deviceId: entry.ieee_address,
      name: entry.description || entry.friendly_name,
      topic: stateTopic,
      manufacturer: entry.definition?.vendor ?? entry.manufacturer,
      model: entry.definition?.model ?? entry.model_id,
      description: entry.definition?.description,
      properties,
    };
  }

  private handleBridgeState(payload: Buffer): void {
    const text = payload.toString().trim();
    let state = text;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === 'object' && parsed !== null && 'state' in parsed) {
        state = String((parsed as { state: unknown }).state);
      }
    } catch {
      // Older Zigbee2MQTT publishes a bare string here.
    }
    this.log.info(`Zigbee2MQTT bridge is ${state}`);
  }

  private handleDeviceMessage(topic: string, payload: Buffer, retained: boolean): void {
    const relative = topic.slice(this.base.length + 1);
    if (!relative || relative.startsWith(`${BRIDGE_PREFIX}/`) || relative === BRIDGE_PREFIX) {
      return;
    }

    const suffix = relative.slice(relative.lastIndexOf('/') + 1);
    if (NON_STATE_SUFFIXES.includes(suffix)) {
      return;
    }
    if (suffix === 'availability') {
      return;
    }

    const deviceId = this.topicIndex.get(relative);
    if (!deviceId) {
      // Either the catalog has not arrived yet, or this is a topic we do not
      // model. Retained state is republished by Zigbee2MQTT on reconnect.
      return;
    }

    const device = this.devices.find((candidate) => candidate.deviceId === deviceId);
    if (!device) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.toString());
    } catch {
      this.log.debug(`Ignoring non JSON payload on ${topic}`);
      return;
    }

    const changes: Record<string, unknown> = {};
    for (const property of device.properties) {
      if (!property.access.readable) {
        continue;
      }
      const value = readPath(parsed, property.extract);
      if (isMissing(value)) {
        continue;
      }
      changes[property.key] = value;
    }

    if (Object.keys(changes).length === 0) {
      return;
    }

    const state = this.states.get(deviceId) ?? {};
    Object.assign(state, changes);
    this.states.set(deviceId, state);

    const update: StateUpdate = {
      sourceId: this.sourceId,
      deviceId,
      changes,
      at: Date.now(),
      retained,
    };
    this.emit('state', update);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createZigbee2mqttAdapter(context: AdapterContext): SourceAdapter {
  return new Zigbee2mqttAdapter(context);
}
