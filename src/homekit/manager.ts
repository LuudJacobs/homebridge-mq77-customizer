import type { API, Characteristic, PlatformAccessory, Service, WithUUID } from 'homebridge';

import type { Catalog } from '../catalog.js';
import type { Logger } from '../logger.js';
import { writePath } from '../model/payload.js';
import type { NormalisedProperty, StateUpdate } from '../model/types.js';
import type { MqttConnection } from '../mqtt/client.js';
import { PLATFORM_NAME, PLUGIN_NAME } from '../settings.js';
import type { Store } from '../store.js';
import {
  planAccessories,
  type AccessoryPlan,
  type Binding,
  type ServiceKind,
  type ServicePlan,
} from './mapping.js';
import { fromHomeKit, toHomeKit, type CharacteristicKind, type Siblings } from './values.js';

interface Managed {
  accessory: PlatformAccessory;
  plan: AccessoryPlan;
}

/**
 * Keeps HomeKit in step with what the user has ticked.
 *
 * Everything here is incremental. Ticking a box adds one accessory and
 * unticking removes one, with no Homebridge restart, which is the whole
 * reason this plugin publishes accessories itself rather than configuring
 * another plugin's config file.
 */
export class AccessoryManager {
  /** Accessories Homebridge replayed from its cache, not yet matched to a plan. */
  private readonly restored = new Map<string, PlatformAccessory>();
  private readonly active = new Map<string, Managed>();

  constructor(
    private readonly api: API,
    private readonly log: Logger,
    private readonly catalog: Catalog,
    private readonly store: Store,
    private readonly mqtt: MqttConnection,
  ) {}

  restore(accessory: PlatformAccessory): void {
    this.restored.set(accessory.UUID, accessory);
  }

  /** Reconciles HomeKit against the current catalog and exposures. */
  sync(): void {
    const desired = new Map<string, AccessoryPlan>();
    for (const device of this.catalog.getDevices()) {
      const exposure = this.store.getExposure(`${device.sourceId}:${device.deviceId}`);
      for (const plan of planAccessories(device, exposure)) {
        desired.set(this.api.hap.uuid.generate(plan.seed), plan);
      }
    }

    const added: PlatformAccessory[] = [];
    for (const [uuid, plan] of desired) {
      const existing = this.active.get(uuid);
      if (existing) {
        this.apply(existing.accessory, plan);
        existing.plan = plan;
        continue;
      }

      const cached = this.restored.get(uuid);
      if (cached) {
        this.restored.delete(uuid);
        this.apply(cached, plan);
        this.active.set(uuid, { accessory: cached, plan });
        this.log.debug(`Adopted cached accessory ${plan.name}`);
        continue;
      }

      const accessory = new this.api.platformAccessory(plan.name, uuid);
      this.apply(accessory, plan);
      this.active.set(uuid, { accessory, plan });
      added.push(accessory);
      this.log.info(`Publishing ${plan.name} to HomeKit`);
    }

    const removed: PlatformAccessory[] = [];
    for (const [uuid, managed] of this.active) {
      if (!desired.has(uuid)) {
        removed.push(managed.accessory);
        this.active.delete(uuid);
        this.log.info(`Removing ${managed.plan.name} from HomeKit`);
      }
    }

    // Anything still in the cache belongs to a device or selection that no
    // longer exists, so it would otherwise linger in the Home app forever.
    for (const [uuid, accessory] of this.restored) {
      removed.push(accessory);
      this.restored.delete(uuid);
      this.log.info(`Removing stale cached accessory ${accessory.displayName}`);
    }

    if (added.length > 0) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, added);
    }
    if (removed.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, removed);
    }
  }

  /** Pushes new values from MQTT into the matching characteristics. */
  handleState(update: StateUpdate): void {
    for (const { accessory, plan } of this.active.values()) {
      if (plan.sourceId !== update.sourceId || plan.deviceId !== update.deviceId) {
        continue;
      }
      for (const service of plan.services) {
        const target = accessory.getServiceById(this.serviceType(service.kind), service.subtype);
        if (!target) {
          continue;
        }

        if (service.events && service.actionPropertyKey) {
          this.fireButton(target, service, update);
          continue;
        }

        // Refresh the whole service when any of its inputs move, not just the
        // characteristic bound to the property that changed. A thermostat's
        // current state is derived from its mode, its setpoint and the room
        // temperature, so a change to any one of them can alter it.
        const touched = service.bindings.some(
          (binding) => binding.propertyKey in update.changes,
        );
        if (!touched) {
          continue;
        }
        for (const binding of service.bindings) {
          this.push(target, plan, service, binding);
        }
      }
    }
  }

  /**
   * A button press arrives as a value on the action property rather than as a
   * state change, so it is republished as a HomeKit event only when the value
   * is one this button knows.
   */
  private fireButton(service: Service, plan: ServicePlan, update: StateUpdate): void {
    const value = update.changes[plan.actionPropertyKey!];
    if (value === undefined || update.retained) {
      // Retained actions are replays of an old press. Firing them would set
      // off automations on every reconnect.
      return;
    }
    const event = plan.events?.[String(value)];
    if (event === undefined) {
      return;
    }
    service.updateCharacteristic(this.api.hap.Characteristic.ProgrammableSwitchEvent, event);
  }

  private apply(accessory: PlatformAccessory, plan: AccessoryPlan): void {
    const { Service, Characteristic } = this.api.hap;

    accessory.displayName = plan.name;
    accessory.context.plan = plan;

    const information =
      accessory.getService(Service.AccessoryInformation) ??
      accessory.addService(Service.AccessoryInformation);
    information
      .setCharacteristic(Characteristic.Manufacturer, plan.manufacturer)
      .setCharacteristic(Characteristic.Model, plan.model)
      .setCharacteristic(Characteristic.SerialNumber, plan.serial);

    // Drop services the user has unticked, and ones whose kind changed so the
    // loop below re-adds them as the new kind.
    for (const service of [...accessory.services]) {
      if (service.UUID === Service.AccessoryInformation.UUID) {
        continue;
      }
      const planned = plan.services.find((candidate) => candidate.subtype === service.subtype);
      if (!planned || this.serviceType(planned.kind).UUID !== service.UUID) {
        accessory.removeService(service);
      }
    }

    let primary: Service | undefined;
    const linked: Service[] = [];

    for (const plannedService of plan.services) {
      const type = this.serviceType(plannedService.kind);
      let service = accessory.getServiceById(type, plannedService.subtype);
      if (!service) {
        service = accessory.addService(type, plannedService.name, plannedService.subtype);
      }
      // Only Name, not ConfiguredName: the latter is not valid on every
      // service and HAP warns about it on every start.
      service.setCharacteristic(Characteristic.Name, plannedService.name);

      for (const constant of plannedService.constants ?? []) {
        service.setCharacteristic(this.characteristic(constant.characteristic), constant.value);
      }

      for (const binding of plannedService.bindings) {
        this.bind(service, plan, plannedService, binding);
        if (binding.characteristic !== 'ProgrammableSwitchEvent') {
          // Without this the Home app shows the HAP default until it happens
          // to read, so a light that is already on can briefly appear off.
          this.push(service, plan, plannedService, binding);
        }
      }

      if (plannedService.link) {
        linked.push(service);
      } else if (!primary) {
        primary = service;
      }
    }

    // Battery shows on the accessory itself rather than as its own tile.
    for (const service of linked) {
      primary?.addLinkedService(service);
    }
  }

  private bind(
    service: Service,
    plan: AccessoryPlan,
    servicePlan: ServicePlan,
    binding: Binding,
  ): void {
    const characteristic: Characteristic = service.getCharacteristic(
      this.characteristic(binding.characteristic),
    );

    if (binding.props) {
      const props = Object.fromEntries(
        Object.entries(binding.props).filter(([, value]) => value !== undefined),
      );
      if (Object.keys(props).length > 0) {
        characteristic.setProps(props);
      }
    }

    // A button event is push only. Giving it a read handler would make HomeKit
    // ask for a value it is not meant to have.
    if (binding.characteristic === 'ProgrammableSwitchEvent') {
      return;
    }

    // Re-binding on every sync would stack duplicate handlers on an accessory
    // the user edits repeatedly.
    characteristic.removeAllListeners('get');
    characteristic.removeAllListeners('set');

    characteristic.onGet(() => {
      const value = this.read(plan, servicePlan, binding);
      if (value === undefined) {
        throw new this.api.hap.HapStatusError(
          this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        );
      }
      return value;
    });

    if (!binding.writable) {
      return;
    }

    characteristic.onSet((value) => {
      const property = this.findProperty(plan, binding.propertyKey);
      if (!property?.setTopic) {
        throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.READ_ONLY_CHARACTERISTIC);
      }
      const wire = fromHomeKit(binding.characteristic, property, value as boolean | number);
      if (wire === undefined) {
        throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
      }
      this.mqtt.publish(
        property.setTopic,
        JSON.stringify(writePath(property.encode ?? property.extract, wire)),
      );
    });
  }

  /** Puts the value we already know into the characteristic. */
  private push(
    service: Service,
    plan: AccessoryPlan,
    servicePlan: ServicePlan,
    binding: Binding,
  ): void {
    const value = this.read(plan, servicePlan, binding);
    if (value !== undefined) {
      service.updateCharacteristic(this.characteristic(binding.characteristic), value);
    }
  }

  private read(
    plan: AccessoryPlan,
    servicePlan: ServicePlan,
    binding: Binding,
  ): boolean | number | undefined {
    const property = this.findProperty(plan, binding.propertyKey);
    const state = this.catalog.getState(plan.sourceId, plan.deviceId);
    if (!property || !state || !(binding.propertyKey in state)) {
      return undefined;
    }
    return toHomeKit(
      binding.characteristic,
      property,
      state[binding.propertyKey],
      this.siblings(plan, servicePlan, state),
    );
  }

  /** The other properties on the same service, for readings that derive from them. */
  private siblings(
    plan: AccessoryPlan,
    servicePlan: ServicePlan,
    state: Readonly<Record<string, unknown>>,
  ): Siblings {
    const siblings: Siblings = {};
    for (const binding of servicePlan.bindings) {
      const property = this.findProperty(plan, binding.propertyKey);
      if (property && binding.propertyKey in state) {
        siblings[binding.role] = { property, value: state[binding.propertyKey] };
      }
    }
    return siblings;
  }

  private findProperty(plan: AccessoryPlan, key: string): NormalisedProperty | undefined {
    return this.catalog
      .getDevice(plan.sourceId, plan.deviceId)
      ?.properties.find((property) => property.key === key);
  }

  private characteristic(kind: CharacteristicKind): WithUUID<new () => Characteristic> {
    return this.api.hap.Characteristic[kind] as unknown as WithUUID<new () => Characteristic>;
  }

  private serviceType(kind: ServiceKind): WithUUID<typeof Service> {
    return this.api.hap.Service[kind] as unknown as WithUUID<typeof Service>;
  }
}
