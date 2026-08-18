import { createJsonTopicAdapter } from './json-topic/adapter.js';
import type { AdapterFactory } from './types.js';
import { createZigbee2mqttAdapter } from './zigbee2mqtt/adapter.js';

/** Adapters by name, as used in the `adapter` field of a source. */
const ADAPTERS: Record<string, AdapterFactory> = {
  zigbee2mqtt: createZigbee2mqttAdapter,
  'json-topic': createJsonTopicAdapter,
};

export function getAdapterFactory(name: string): AdapterFactory | undefined {
  return ADAPTERS[name];
}

export function adapterNames(): string[] {
  return Object.keys(ADAPTERS);
}

export type { AdapterContext, AdapterFactory, SourceAdapter, SourceConfig } from './types.js';
