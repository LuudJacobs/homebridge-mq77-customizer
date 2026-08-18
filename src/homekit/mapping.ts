import type { CatalogDevice } from '../catalog.js';
import type { NormalisedProperty } from '../model/types.js';
import { DEVICE_ENDPOINT, type DeviceExposure, type TileType } from '../store.js';
import { buttonsFrom, roleFor, ROLE_GROUPS, type Role, type ServiceGroup } from './roles.js';
import type { CharacteristicKind } from './values.js';

export type ServiceKind =
  | 'Switch'
  | 'Outlet'
  | 'Lightbulb'
  | 'Fan'
  | 'Thermostat'
  | 'TemperatureSensor'
  | 'HumiditySensor'
  | 'Battery'
  | 'StatelessProgrammableSwitch';

export interface CharacteristicProps {
  minValue?: number;
  maxValue?: number;
  minStep?: number;
  validValues?: number[];
}

export interface Binding {
  characteristic: CharacteristicKind;
  propertyKey: string;
  role: Role;
  writable: boolean;
  /** Narrows the HomeKit control to what the device actually accepts. */
  props?: CharacteristicProps;
}

export interface ServicePlan {
  kind: ServiceKind;
  subtype: string;
  name: string;
  bindings: Binding[];
  /** Characteristics with a fixed value, such as a button's index. */
  constants?: { characteristic: CharacteristicKind; value: number }[];
  /** Linked to the accessory's primary service, which is how battery is shown. */
  link?: boolean;
  /** Button service only: which action values fire which HomeKit event. */
  events?: Record<string, number>;
  /** Button service only: the property carrying those values. */
  actionPropertyKey?: string;
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

export { isPublishable, roleFor } from './roles.js';

const TILE_KINDS: Record<TileType, ServiceKind> = {
  Switch: 'Switch',
  Outlet: 'Outlet',
  Lightbulb: 'Lightbulb',
  Fan: 'Fan',
};

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
    (property) => selected.has(property.key) && roleFor(property) !== undefined,
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
    return present([buildPlan(device, exposure, DEVICE_ENDPOINT, publishable, false)]);
  }

  return present(
    [...byEndpoint.entries()].map(([endpoint, properties]) =>
      buildPlan(device, exposure, endpoint, properties, true),
    ),
  );
}

function present(plans: AccessoryPlan[]): AccessoryPlan[] {
  // A selection can be publishable in principle yet produce no service, for
  // instance a child lock with nothing to attach it to.
  return plans.filter((plan) => plan.services.length > 0);
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
  const name = exposure.names?.[endpoint] || defaultName(device, exposure, endpoint, split);

  const grouped = new Map<ServiceGroup, NormalisedProperty[]>();
  for (const property of properties) {
    const role = roleFor(property);
    if (!role) {
      continue;
    }
    const group = ROLE_GROUPS[role];
    const bucket = grouped.get(group);
    if (bucket) {
      bucket.push(property);
    } else {
      grouped.set(group, [property]);
    }
  }

  const services: ServicePlan[] = [
    ...tileServices(grouped.get('tile') ?? [], exposure, name, properties.length > 1),
    ...thermostatServices(grouped.get('thermostat') ?? [], name),
    ...sensorServices(grouped.get('temperature') ?? [], 'TemperatureSensor', 'CurrentTemperature', name, 'Temperature'),
    ...sensorServices(grouped.get('humidity') ?? [], 'HumiditySensor', 'CurrentRelativeHumidity', name, 'Humidity'),
    ...batteryServices(grouped.get('battery') ?? []),
    ...buttonServices(grouped.get('buttons') ?? [], name, exposure),
  ];

  return {
    seed,
    name,
    sourceId: device.sourceId,
    deviceId: device.deviceId,
    endpoint,
    manufacturer: device.manufacturer ?? 'Unknown',
    model: device.model ?? 'Unknown',
    serial: split ? `${device.deviceId}-${endpoint}` : device.deviceId,
    services,
  };
}

/**
 * The on/off tile, plus anything that belongs on it.
 *
 * Brightness only exists on a Lightbulb, so selecting it settles the tile type
 * regardless of what was picked. Offering the choice and then ignoring it
 * would be worse than overriding it.
 */
function tileServices(
  properties: NormalisedProperty[],
  exposure: DeviceExposure,
  accessoryName: string,
  qualify: boolean,
): ServicePlan[] {
  // One tile per endpoint, so a dual channel switch kept as a single accessory
  // still gets both of its channels.
  const byEndpoint = new Map<string, NormalisedProperty[]>();
  for (const property of properties) {
    const endpoint = property.endpoint ?? DEVICE_ENDPOINT;
    const bucket = byEndpoint.get(endpoint);
    if (bucket) {
      bucket.push(property);
    } else {
      byEndpoint.set(endpoint, [property]);
    }
  }

  const services: ServicePlan[] = [];

  for (const [endpoint, group] of byEndpoint) {
    const byRole = indexByRole(group);
    const power = byRole.power;
    if (!power) {
      // A child lock with no switch to attach it to has nowhere to live in
      // HomeKit. It stays available to the rules engine.
      continue;
    }

    const brightness = byRole.brightness;
    const speed = byRole.rotationSpeed;
    const swing = byRole.swingMode;
    const chosen = exposure.tileTypes?.[endpoint] ?? 'Switch';

    // Brightness exists only on a Lightbulb, speed and swing only on a Fan, so
    // whichever is present settles the tile. Brightness wins if a device
    // somehow reports both.
    const kind: ServiceKind = brightness
      ? 'Lightbulb'
      : speed || swing
        ? 'Fan'
        : TILE_KINDS[chosen];

    const bindings: Binding[] = [
      { characteristic: 'On', propertyKey: power.key, role: 'power', writable: true },
    ];

    if (brightness) {
      bindings.push({
        characteristic: 'Brightness',
        propertyKey: brightness.key,
        role: 'brightness',
        writable: brightness.access.writable,
      });
    } else {
      if (speed) {
        bindings.push({
          characteristic: 'RotationSpeed',
          propertyKey: speed.key,
          role: 'rotationSpeed',
          writable: speed.access.writable,
        });
      }
      if (swing) {
        bindings.push({
          characteristic: 'SwingMode',
          propertyKey: swing.key,
          role: 'swingMode',
          writable: swing.access.writable,
        });
      }
    }

    const childLock = byRole.childLock;
    if (childLock) {
      bindings.push({
        characteristic: 'LockPhysicalControls',
        propertyKey: childLock.key,
        role: 'childLock',
        writable: childLock.access.writable,
      });
    }

    services.push({
      kind,
      subtype: power.key,
      name: qualify ? qualifiedName(accessoryName, power) : accessoryName,
      bindings,
    });
  }

  return services;
}

function thermostatServices(
  properties: NormalisedProperty[],
  accessoryName: string,
): ServicePlan[] {
  const byRole = indexByRole(properties);
  const mode = byRole.thermostatMode;
  if (!mode) {
    return [];
  }

  const bindings: Binding[] = [
    {
      characteristic: 'TargetHeatingCoolingState',
      propertyKey: mode.key,
      role: 'thermostatMode',
      writable: true,
      // Only offer modes the device declares, so HomeKit cannot send one back
      // that the device would reject.
      props: { validValues: validModes(mode) },
    },
    {
      characteristic: 'CurrentHeatingCoolingState',
      propertyKey: mode.key,
      role: 'thermostatMode',
      writable: false,
    },
  ];

  const target = byRole.targetTemperature;
  if (target) {
    bindings.push({
      characteristic: 'TargetTemperature',
      propertyKey: target.key,
      role: 'targetTemperature',
      writable: true,
      // HomeKit defaults to 10 to 38, which would refuse this thermostat's
      // range of 5 to 30.
      props: { minValue: target.min, maxValue: target.max, minStep: target.step },
    });
  }

  const current = byRole.localTemperature;
  if (current) {
    bindings.push({
      characteristic: 'CurrentTemperature',
      propertyKey: current.key,
      role: 'localTemperature',
      writable: false,
    });
  }

  return [
    { kind: 'Thermostat', subtype: mode.key, name: `${accessoryName} Thermostat`, bindings },
  ];
}

function sensorServices(
  properties: NormalisedProperty[],
  kind: ServiceKind,
  characteristic: CharacteristicKind,
  accessoryName: string,
  label: string,
): ServicePlan[] {
  return properties.map((property) => ({
    kind,
    subtype: property.key,
    name: `${accessoryName} ${label}`,
    bindings: [
      {
        characteristic,
        propertyKey: property.key,
        role: roleFor(property) as Role,
        writable: false,
      },
    ],
  }));
}

/** Battery is linked rather than standalone, so it shows on the accessory itself. */
function batteryServices(properties: NormalisedProperty[]): ServicePlan[] {
  return properties.map((property) => ({
    kind: 'Battery' as const,
    subtype: property.key,
    name: 'Battery',
    link: true,
    bindings: [
      { characteristic: 'BatteryLevel' as const, propertyKey: property.key, role: 'battery' as const, writable: false },
      { characteristic: 'StatusLowBattery' as const, propertyKey: property.key, role: 'battery' as const, writable: false },
    ],
  }));
}

/**
 * One service per physical button, since HomeKit models a button as a service
 * carrying single, double and long press rather than a list of named events.
 */
function buttonServices(
  properties: NormalisedProperty[],
  accessoryName: string,
  exposure: DeviceExposure,
): ServicePlan[] {
  const services: ServicePlan[] = [];

  for (const property of properties) {
    const buttons = buttonsFrom(property.values ?? []);
    const selection = exposure.buttons?.[property.key];
    let index = 0;

    for (const [button, actions] of buttons) {
      // Numbered over every button the device has, not only the published
      // ones, so enabling a button later does not renumber the others.
      index += 1;

      // No entry means every gesture. An empty list means the user turned the
      // button off, which is different from never having chosen.
      const allowed = selection?.[button];

      const events: Record<string, number> = {};
      for (const action of actions) {
        if (action.event === undefined) {
          continue;
        }
        if (allowed && !allowed.includes(action.event)) {
          continue;
        }
        events[action.value] = action.event;
      }

      // A button with nothing left, either because it was switched off or
      // because every gesture is one HomeKit cannot express, would be an empty
      // tile. Leave it to the rules engine.
      if (Object.keys(events).length === 0) {
        continue;
      }

      services.push({
        kind: 'StatelessProgrammableSwitch',
        subtype: `${property.key}:${button}`,
        name: `${accessoryName} ${button}`,
        constants: [{ characteristic: 'ServiceLabelIndex', value: index }],
        events,
        actionPropertyKey: property.key,
        bindings: [
          {
            characteristic: 'ProgrammableSwitchEvent',
            propertyKey: property.key,
            role: 'action',
            writable: false,
            // Restricting the valid values makes the Home app offer only the
            // gestures that were kept, rather than all three.
            props: { validValues: [...new Set(Object.values(events))].sort() },
          },
        ],
      });
    }
  }

  return services;
}

function indexByRole(
  properties: NormalisedProperty[],
): Partial<Record<Role, NormalisedProperty>> {
  const byRole: Partial<Record<Role, NormalisedProperty>> = {};
  for (const property of properties) {
    const role = roleFor(property);
    if (role && !byRole[role]) {
      byRole[role] = property;
    }
  }
  return byRole;
}

function validModes(mode: NormalisedProperty): number[] | undefined {
  const names = mode.values?.map((value) => String(value).toLowerCase());
  if (!names?.length) {
    return undefined;
  }
  const codes = { off: 0, heat: 1, cool: 2, auto: 3 } as Record<string, number>;
  const valid = names.map((name) => codes[name]).filter((code): code is number => code !== undefined);
  return valid.length > 0 ? valid : undefined;
}

function defaultName(
  device: CatalogDevice,
  exposure: DeviceExposure,
  endpoint: string,
  split: boolean,
): string {
  const base = exposure.label?.trim() || device.name;
  if (!split || endpoint === DEVICE_ENDPOINT) {
    return base;
  }
  return `${base} ${endpoint}`;
}

function qualifiedName(accessoryName: string, property: NormalisedProperty): string {
  return property.endpoint
    ? `${accessoryName} ${property.endpoint}`
    : `${accessoryName} ${property.label}`;
}
