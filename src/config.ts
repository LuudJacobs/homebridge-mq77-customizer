import { adapterNames, getAdapterFactory } from './adapters/index.js';
import type { SourceConfig } from './adapters/types.js';
import type { Logger } from './logger.js';
import type { BrokerConfig } from './mqtt/client.js';

export interface WebConfig {
  port: number;
  password?: string;
}

export interface PluginConfig {
  name: string;
  broker: BrokerConfig;
  sources: SourceConfig[];
  web: WebConfig;
}

const DEFAULT_BROKER: BrokerConfig = { host: 'localhost', port: 1883 };
const DEFAULT_WEB_PORT = 8888;

/**
 * Fills in defaults and drops entries that cannot work, logging why.
 *
 * A bad source is skipped rather than fatal, so one typo does not take the
 * whole platform down.
 */
export function resolveConfig(raw: Record<string, unknown>, log: Logger): PluginConfig {
  const brokerRaw = asObject(raw.broker) ?? {};
  const broker: BrokerConfig = {
    host: asString(brokerRaw.host) ?? DEFAULT_BROKER.host,
    port: asNumber(brokerRaw.port) ?? DEFAULT_BROKER.port,
    username: asString(brokerRaw.username),
    password: asString(brokerRaw.password),
    clientId: asString(brokerRaw.clientId),
  };

  const webRaw = asObject(raw.web) ?? {};
  const web: WebConfig = {
    port: asNumber(webRaw.port) ?? DEFAULT_WEB_PORT,
    // Trimmed, so a password of spaces counts as no password rather than as a
    // secret nobody could type.
    password: asString(webRaw.password)?.trim() || undefined,
  };

  if (!web.password) {
    log.warn(
      'No web password set. The web interface will not start, so nothing is served on its port.',
    );
  }

  const sources = resolveSources(raw.sources, log);

  return {
    name: asString(raw.name) ?? 'MQTT Customizer',
    broker,
    sources,
    web,
  };
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
    });
  }

  return sources;
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
