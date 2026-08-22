import { EventEmitter } from 'node:events';

import type { Logger } from '../../logger.js';
import type { MqttConnection } from '../../mqtt/client.js';
import { joinTopic } from '../../mqtt/topics.js';
import { isMissing, isPlainObject, readPath } from '../../model/payload.js';
import type { NormalisedDevice, StateUpdate } from '../../model/types.js';
import type {
  AdapterContext,
  AdapterEvents,
  NetworkLink,
  NetworkMap,
  NetworkNode,
  SourceAdapter,
  SourceConfig,
} from '../types.js';
import { flattenExposes } from './exposes.js';
import type { Z2mDevice } from './protocol.js';

/** Topics under `<base>/` that carry bridge traffic rather than device state. */
const BRIDGE_PREFIX = 'bridge';
/**
 * How long to wait for a network scan.
 *
 * Every device is questioned in turn and a sleepy one holds things up, so
 * minutes is normal on a mesh of any size.
 */
const MAP_TIMEOUT_MS = 180_000;
/** Device topic suffixes that are commands or metadata, not state. */
const NON_STATE_SUFFIXES = ['set', 'get'];

export class Zigbee2mqttAdapter
  extends EventEmitter<AdapterEvents>
  implements SourceAdapter
{
  readonly sourceId: string;
  /** Renaming belongs in Zigbee2MQTT, which publishes the name back to us. */
  readonly providesNames = true;

  private readonly source: SourceConfig;
  private readonly mqtt: MqttConnection;
  private readonly log: Logger;
  private readonly base: string;

  private devices: NormalisedDevice[] = [];
  /** The scan in flight, so two askers wait on one answer. */
  private mapPending?: {
    promise: Promise<NetworkMap>;
    resolve: (map: NetworkMap) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
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

    this.unsubscribes.push(
      this.mqtt.subscribe(
        joinTopic(this.base, BRIDGE_PREFIX, 'response', 'networkmap'),
        (message) => {
          this.handleNetworkMap(message.payload);
        },
      ),
    );

    this.log.info(`Watching ${this.base}/bridge/devices`);
  }

  /**
   * Asks Zigbee2MQTT to walk the mesh and report what it found.
   *
   * The bridge answers on its own topic rather than to the asker, so the
   * request and the reply are tied together here and not by the protocol.
   */
  async getNetworkMap(): Promise<NetworkMap> {
    if (this.mapPending) {
      return this.mapPending.promise;
    }

    let resolve!: (map: NetworkMap) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<NetworkMap>((yes, no) => {
      resolve = yes;
      reject = no;
    });

    const timer = setTimeout(() => {
      this.mapPending = undefined;
      reject(
        new Error(
          `Zigbee2MQTT did not answer within ${MAP_TIMEOUT_MS / 1000} seconds. ` +
            'A scan questions every device in turn, so a sleeping one can hold it up.',
        ),
      );
    }, MAP_TIMEOUT_MS);
    timer.unref?.();

    this.mapPending = { promise, resolve, reject, timer };

    this.log.info('Asking for the network map, which takes a while');
    this.mqtt.publish(
      joinTopic(this.base, BRIDGE_PREFIX, 'request', 'networkmap'),
      JSON.stringify({ type: 'raw', routes: false }),
    );

    return promise;
  }

  private handleNetworkMap(payload: Buffer): void {
    const pending = this.mapPending;
    if (!pending) {
      // Somebody else asked, or ours already timed out. Either way it is not
      // an answer to a question we are still waiting on.
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.toString());
    } catch (error) {
      return this.failMap(`the network map was not valid JSON: ${describe(error)}`);
    }

    if (!isPlainObject(parsed)) {
      return this.failMap('the network map was not an object');
    }
    if (parsed.status !== undefined && parsed.status !== 'ok') {
      const why = isPlainObject(parsed.error) ? '' : String(parsed.error ?? 'no reason given');
      return this.failMap(`Zigbee2MQTT refused the scan: ${why}`);
    }

    const data = isPlainObject(parsed.data) ? parsed.data : undefined;
    const value = data && isPlainObject(data.value) ? data.value : undefined;
    if (!value || !Array.isArray(value.nodes)) {
      return this.failMap('the network map had no nodes in it');
    }

    const map = readNetworkMap(value.nodes, Array.isArray(value.links) ? value.links : []);

    clearTimeout(pending.timer);
    this.mapPending = undefined;
    this.log.info(`Network map: ${map.nodes.length} devices, ${map.links.length} links`);
    pending.resolve(map);
  }

  private failMap(why: string): void {
    const pending = this.mapPending;
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.mapPending = undefined;
    this.log.error(why);
    pending.reject(new Error(why));
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

/**
 * Reads the raw scan into the shape the interface draws.
 *
 * A link is only kept when both ends are devices the scan reported, since a
 * line to nothing cannot be drawn and usually means a device that has left.
 */
export function readNetworkMap(rawNodes: unknown[], rawLinks: unknown[]): NetworkMap {
  const nodes: NetworkNode[] = [];
  const known = new Set<string>();

  for (const raw of rawNodes) {
    if (!isPlainObject(raw)) {
      continue;
    }
    const address = typeof raw.ieeeAddr === 'string' ? raw.ieeeAddr : undefined;
    if (!address || known.has(address)) {
      continue;
    }
    known.add(address);
    nodes.push({
      address,
      name: typeof raw.friendlyName === 'string' ? raw.friendlyName : address,
      kind: kindOf(raw.type),
      ...(raw.failed ? { failed: true } : {}),
    });
  }

  const links: NetworkLink[] = [];
  const seen = new Set<string>();

  for (const raw of rawLinks) {
    if (!isPlainObject(raw)) {
      continue;
    }
    const from = endOf(raw.source, raw.sourceIeeeAddr);
    const to = endOf(raw.target, raw.targetIeeeAddr);
    if (!from || !to || from === to || !known.has(from) || !known.has(to)) {
      continue;
    }

    // Two devices that can hear each other report the link twice, once from
    // each side. It is one line on the map either way.
    const pair = [from, to].sort().join('~');
    if (seen.has(pair)) {
      continue;
    }
    seen.add(pair);

    links.push({
      from,
      to,
      quality: typeof raw.linkquality === 'number' ? raw.linkquality : 0,
    });
  }

  return { nodes, links, at: Date.now() };
}

function kindOf(type: unknown): NetworkNode['kind'] {
  const name = String(type ?? '').toLowerCase();
  if (name === 'coordinator') {
    return 'coordinator';
  }
  return name === 'router' ? 'router' : 'end device';
}

/** The address of one end of a link, whichever way this version reports it. */
function endOf(side: unknown, fallback: unknown): string | undefined {
  if (isPlainObject(side) && typeof side.ieeeAddr === 'string') {
    return side.ieeeAddr;
  }
  return typeof fallback === 'string' ? fallback : undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createZigbee2mqttAdapter(context: AdapterContext): SourceAdapter {
  return new Zigbee2mqttAdapter(context);
}
