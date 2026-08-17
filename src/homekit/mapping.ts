import type { CatalogDevice } from '../catalog.js';
import type { NormalisedProperty } from '../model/types.js';
import { DEVICE_ENDPOINT, type DeviceExposure, type TileType } from '../store.js';

export interface ServicePlan {
  tile: TileType;
  /** Property this service switches. */
  propertyKey: string;
  /** Distinguishes services of the same type on one accessory. */
  subtype: string;
  name: string;
}

export interface AccessoryPlan {
  /** Stable seed for the HomeKit UUID. Changing it makes HomeKit forget the accessory. */
  seed: string;
  name: string;
  sourceId: string;
  deviceId: string;
  /** Empty string for properties belonging to the device as a whole. */
  endpoint: string;
  manufacturer: string;
  model: string;
  serial: string;
  services: ServicePlan[];
}

/**
 * Properties that can become a HomeKit tile in this version.
 *
 * v0.2.0 publishes on/off only. Brightness, climate, sensors and buttons
 * arrive with the full mapping table in v0.3.0, at which point this widens.
 */
export function isPublishable(property: NormalisedProperty): boolean {
  return property.type === 'binary' && property.access.writable && property.access.readable;
}

/**
 * Works out which accessories a device should produce.
 *
 * When endpoints are split, properties belonging to the device as a whole get
 * their own accessory rather than being attached to an arbitrary endpoint.
 * That keeps the result predictable for something like the power strip, where
 * three outlets share one meter.
 */
export function planAccessories(
  device: CatalogDevice,
  exposure: DeviceExposure | undefined,
): AccessoryPlan[] {
  if (device.rulesOnly || !exposure) {
    return [];
  }

  const selected = new Set(exposure.properties);
  const publishable = device.properties.filter(
    (property) => selected.has(property.key) && isPublishable(property),
  );
  if (publishable.length === 0) {
    return [];
  }

  const byEndpoint = new Map<string, NormalisedProperty[]>();
  for (const property of publishable) {
    const endpoint = property.endpoint ?? DEVICE_ENDPOINT;
    const group = byEndpoint.get(endpoint);
    if (group) {
      group.push(property);
    } else {
      byEndpoint.set(endpoint, [property]);
    }
  }

  const split = exposure.splitEndpoints === true && byEndpoint.size > 1;

  if (!split) {
    return [buildPlan(device, exposure, DEVICE_ENDPOINT, publishable, false)];
  }

  return [...byEndpoint.entries()].map(([endpoint, properties]) =>
    buildPlan(device, exposure, endpoint, properties, true),
  );
}

function buildPlan(
  device: CatalogDevice,
  exposure: DeviceExposure,
  endpoint: string,
  properties: NormalisedProperty[],
  split: boolean,
): AccessoryPlan {
  const seed = split
    ? `${device.sourceId}:${device.deviceId}:${endpoint}`
    : `${device.sourceId}:${device.deviceId}`;

  const services: ServicePlan[] = properties.map((property) => ({
    tile: exposure.tileTypes?.[property.endpoint ?? DEVICE_ENDPOINT] ?? 'Switch',
    propertyKey: property.key,
    subtype: property.key,
    // With several services on one accessory HomeKit shows each service name,
    // so a bare "State" would be ambiguous between endpoints.
    name: serviceName(device, property, properties.length > 1),
  }));

  return {
    seed,
    name: exposure.names?.[endpoint] || defaultName(device, endpoint, split),
    sourceId: device.sourceId,
    deviceId: device.deviceId,
    endpoint,
    manufacturer: device.manufacturer ?? 'Unknown',
    model: device.model ?? 'Unknown',
    serial: split ? `${device.deviceId}-${endpoint}` : device.deviceId,
    services,
  };
}

function defaultName(device: CatalogDevice, endpoint: string, split: boolean): string {
  if (!split || endpoint === DEVICE_ENDPOINT) {
    return device.name;
  }
  return `${device.name} ${endpoint}`;
}

function serviceName(
  device: CatalogDevice,
  property: NormalisedProperty,
  qualify: boolean,
): string {
  if (!qualify) {
    return device.name;
  }
  return property.endpoint ? `${device.name} ${property.endpoint}` : `${device.name} ${property.label}`;
}

/** Reads a wire value as a HomeKit boolean, using the property's own on/off values. */
export function toBoolean(property: NormalisedProperty, value: unknown): boolean {
  if (property.onValue !== undefined && value === property.onValue) {
    return true;
  }
  if (property.offValue !== undefined && value === property.offValue) {
    return false;
  }
  // Devices are not always consistent about types, so fall back to the
  // obvious readings rather than reporting a stale value.
  if (typeof value === 'string') {
    return value.toUpperCase() === 'ON' || value.toUpperCase() === 'TRUE';
  }
  return Boolean(value);
}

/** Produces the wire value for a HomeKit boolean. */
export function fromBoolean(property: NormalisedProperty, on: boolean): unknown {
  if (on) {
    return property.onValue ?? true;
  }
  return property.offValue ?? false;
}
