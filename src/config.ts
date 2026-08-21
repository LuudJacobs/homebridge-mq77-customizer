import { adapterNames, getAdapterFactory } from './adapters/index.js';
import type { DeclaredDevice, SourceConfig } from './adapters/types.js';
import type { Logger } from './logger.js';
import type { BrokerConfig } from './mqtt/client.js';

export interface WebConfig {
  port: number;
  password?: string;
  /** Optional link to the Zigbee2MQTT interface, shown in the tab bar. */
  zigbee2mqttUrl?: string;
}

export interface PluginConfig {
  name: string;
  broker: BrokerConfig;
  sources: SourceConfig[];
  web: WebConfig;
}

const DEFAULT_BROKER: BrokerConfig = { host: 'localhost', port: 1883 };
export const DEFAULT_ADDRESS = 'localhost:1883';
const DEFAULT_WEB_PORT = 8888;

/**
 * Fills in defaults and drops entries that cannot work, logging why.
 *
 * A bad source is skipped rather than fatal, so one typo does not take the
 * whole platform down.
 */
export function resolveConfig(raw: Record<string, unknown>, log: Logger): PluginConfig {
  const brokerRaw = asObject(raw.broker) ?? {};

  // One field now, `host:port`. Earlier versions stored the two separately and
  // those settings are still read, so an upgrade does not lose the broker.
  const address = asString(brokerRaw.address);
  const parsed = address ? parseAddress(address, log) : undefined;

  // Credentials stay stored while the box is unticked, so turning
  // authentication off and on again does not mean typing them in twice.
  const authenticated = brokerRaw.requiresAuth === true;

  const broker: BrokerConfig = {
    host: parsed?.host ?? asString(brokerRaw.host) ?? DEFAULT_BROKER.host,
    port: parsed?.port ?? asNumber(brokerRaw.port) ?? DEFAULT_BROKER.port,
    username: authenticated ? asString(brokerRaw.username) : undefined,
    password: authenticated ? asString(brokerRaw.password) : undefined,
    clientId: asString(brokerRaw.clientId),
  };

  const webRaw = asObject(raw.web) ?? {};
  const web: WebConfig = {
    port: asNumber(webRaw.port) ?? DEFAULT_WEB_PORT,
    // Trimmed, so a password of spaces counts as no password rather than as a
    // secret nobody could type.
    password: asString(webRaw.password)?.trim() || undefined,
    zigbee2mqttUrl: asWebUrl(webRaw.zigbee2mqttUrl, log),
  };

  if (!web.password) {
    log.warn(
      'No web password set. The web interface will not start, so nothing is served on its port.',
    );
  }

  const sources = resolveSources(raw.sources, log);

  return {
    name: asString(raw.name) ?? 'MQ77 Customizer',
    broker,
    sources,
    web,
  };
}

/**
 * Devices described by hand, for a source that cannot describe itself.
 *
 * Whether a named function means anything is the adapter's business, since it
 * is the one that knows what a key is worth. Here it is only read.
 */
function resolveDeclared(raw: unknown, id: string, log: Logger): DeclaredDevice[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    log.error(`Source "${id}" has a "devices" that is not a list, ignoring it`);
    return undefined;
  }

  const devices: DeclaredDevice[] = [];
  for (const [index, entry] of raw.entries()) {
    const object = asObject(entry);
    const topic = object && asString(object.topic);
    if (!topic) {
      log.error(`Source "${id}" device ${index} needs a topic, skipping it`);
      continue;
    }

    const properties = (Array.isArray(object.properties) ? object.properties : [])
      .filter((property): property is string => typeof property === 'string' && property !== '');

    if (properties.length === 0) {
      log.error(`Source "${id}" device "${topic}" lists no functions, skipping it`);
      continue;
    }
    devices.push({ topic, properties });
  }

  return devices.length > 0 ? devices : undefined;
}

function resolveSources(raw: unknown, log: Logger): SourceConfig[] {
  if (raw === undefined) {
    log.info('No sources configured, defaulting to Zigbee2MQTT on base topic "zigbee2mqtt"');
    return [{ id: 'zigbee2mqtt', adapter: 'zigbee2mqtt', baseTopic: 'zigbee2mqtt' }];
  }

  if (!Array.isArray(raw)) {
    log.error('"sources" is not a list, ignoring it');
    return [];
  }

  const sources: SourceConfig[] = [];
  const seen = new Set<string>();

  for (const [index, entry] of raw.entries()) {
    const object = asObject(entry);
    if (!object) {
      log.error(`Source ${index} is not an object, skipping it`);
      continue;
    }

    const id = asString(object.id);
    const adapter = asString(object.adapter);
    const baseTopic = asString(object.baseTopic);

    if (!id || !adapter || !baseTopic) {
      log.error(`Source ${index} needs id, adapter and baseTopic, skipping it`);
      continue;
    }

    if (seen.has(id)) {
      log.error(`Source id "${id}" is used more than once, skipping the duplicate`);
      continue;
    }

    if (!getAdapterFactory(adapter)) {
      log.error(
        `Source "${id}" wants unknown adapter "${adapter}". Available: ${adapterNames().join(', ')}`,
      );
      continue;
    }

    seen.add(id);
    sources.push({
      id,
      adapter,
      baseTopic,
      rulesOnly: object.rulesOnly === true,
      topics: asString(object.topics),
      setTopicSuffix: asString(object.setTopicSuffix),
      devices: resolveDeclared(object.devices, id, log),
    });
  }

  return sources;
}

/**
 * Splits `host:port`, and copes with the ways that can be written.
 *
 * A bare host keeps the default port. An IPv6 address is full of colons, so
 * only a bracketed one can carry a port, and the brackets come off since that
 * is what the client expects.
 */
export function parseAddress(
  address: string,
  log: Logger,
): { host: string; port: number } | undefined {
  const trimmed = address.trim();
  if (!trimmed) {
    return undefined;
  }

  const bracketed = /^\[(.+)\](?::(\d+))?$/.exec(trimmed);
  if (bracketed) {
    return { host: bracketed[1]!, port: Number(bracketed[2] ?? DEFAULT_BROKER.port) };
  }

  // No colon means a bare host. Several, without brackets, means a bare IPv6
  // address, which cannot carry a port since there is no telling where the
  // address ends. Either way the default port stands.
  const colons = trimmed.split(':').length - 1;
  if (colons !== 1) {
    return { host: trimmed, port: DEFAULT_BROKER.port };
  }

  const colon = trimmed.lastIndexOf(':');

  const host = trimmed.slice(0, colon);
  const port = Number(trimmed.slice(colon + 1));

  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    log.warn(`"${address}" is not a usable broker address, using ${DEFAULT_ADDRESS}`);
    return undefined;
  }

  return { host, port };
}

/**
 * Accepts only something a browser can actually open.
 *
 * The value ends up as a link in the interface, so anything else, including a
 * bare host or another scheme, is dropped rather than rendered as a link that
 * goes nowhere.
 */
function asWebUrl(value: unknown, log: Logger): string | undefined {
  const text = asString(value)?.trim();
  if (!text) {
    return undefined;
  }
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('not a web address');
    }
    return url.toString();
  } catch {
    log.warn(`Ignoring "${text}" as the Zigbee2MQTT address, it needs to start with http:// or https://`);
    return undefined;
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
