import type { AdapterFactory } from './types.js';
import { createZigbee2mqttAdapter } from './zigbee2mqtt/adapter.js';

/**
 * Adapters by name, as used in the `adapter` field of a source.
 *
 * `json-topic`, covering flat JSON publishers, lands in v0.4.0.
 */
const ADAPTERS: Record<string, AdapterFactory> = {
  zigbee2mqtt: createZigbee2mqttAdapter,
};

export function getAdapterFactory(name: string): AdapterFactory | undefined {
  return ADAPTERS[name];
}

export function adapterNames(): string[] {
  return Object.keys(ADAPTERS);
}

export type { AdapterContext, AdapterFactory, SourceAdapter, SourceConfig } from './types.js';
