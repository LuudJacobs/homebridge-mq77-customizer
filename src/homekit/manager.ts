import type { API, Characteristic, PlatformAccessory, Service, WithUUID } from 'homebridge';

import type { Catalog } from '../catalog.js';
import type { Logger } from '../logger.js';
import { writePath } from '../model/payload.js';
import type { NormalisedProperty, StateUpdate } from '../model/types.js';
import type { MqttConnection } from '../mqtt/client.js';
import { PLATFORM_NAME, PLUGIN_NAME } from '../settings.js';
import type { Store, TileType } from '../store.js';
import { fromBoolean, planAccessories, toBoolean, type AccessoryPlan } from './mapping.js';

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
        if (!(service.propertyKey in update.changes)) {
          continue;
        }
        const property = this.findProperty(plan, service.propertyKey);
        if (!property) {
          continue;
        }
        const target = accessory.getServiceById(
          this.serviceType(service.tile),
          service.subtype,
        );
        target?.updateCharacteristic(
          this.api.hap.Characteristic.On,
          toBoolean(property, update.changes[service.propertyKey]),
        );
      }
    }
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

    // Drop services the user has unticked, and ones whose tile type changed so
    // the loop below re-adds them as the new type.
    for (const service of [...accessory.services]) {
      if (service.UUID === Service.AccessoryInformation.UUID) {
        continue;
      }
      const planned = plan.services.find((candidate) => candidate.subtype === service.subtype);
      if (!planned || this.serviceType(planned.tile).UUID !== service.UUID) {
        accessory.removeService(service);
      }
    }

    for (const plannedService of plan.services) {
      const type = this.serviceType(plannedService.tile);
      let service = accessory.getServiceById(type, plannedService.subtype);
      if (!service) {
        service = accessory.addService(type, plannedService.name, plannedService.subtype);
      }
      // Only Name, not ConfiguredName: the latter is not valid on a Switch or
      // Outlet service and HAP warns about it on every start.
      service.setCharacteristic(Characteristic.Name, plannedService.name);
      this.bind(service, plan, plannedService.propertyKey);
      this.seed(service, plan, plannedService.propertyKey);
    }
  }

  private bind(service: Service, plan: AccessoryPlan, propertyKey: string): void {
    const characteristic: Characteristic = service.getCharacteristic(
      this.api.hap.Characteristic.On,
    );
    // Re-binding on every sync would stack duplicate handlers on an accessory
    // the user edits repeatedly.
    characteristic.removeAllListeners('get');
    characteristic.removeAllListeners('set');

    characteristic.onGet(() => {
      const property = this.findProperty(plan, propertyKey);
      const state = this.catalog.getState(plan.sourceId, plan.deviceId);
      if (!property || !state || !(propertyKey in state)) {
        throw new this.api.hap.HapStatusError(
          this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        );
      }
      return toBoolean(property, state[propertyKey]);
    });

    characteristic.onSet((value) => {
      const property = this.findProperty(plan, propertyKey);
      if (!property?.setTopic) {
        throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.READ_ONLY_CHARACTERISTIC);
      }
      const payload = writePath(
        property.encode ?? property.extract,
        fromBoolean(property, value === true),
      );
      this.mqtt.publish(property.setTopic, JSON.stringify(payload));
    });
  }

  /**
   * Puts the value we already know into the characteristic.
   *
   * Without this the Home app shows the HAP default until it happens to read,
   * so a light that is already on can briefly appear off.
   */
  private seed(service: Service, plan: AccessoryPlan, propertyKey: string): void {
    const property = this.findProperty(plan, propertyKey);
    const state = this.catalog.getState(plan.sourceId, plan.deviceId);
    if (!property || !state || !(propertyKey in state)) {
      return;
    }
    service.updateCharacteristic(
      this.api.hap.Characteristic.On,
      toBoolean(property, state[propertyKey]),
    );
  }

  private findProperty(plan: AccessoryPlan, key: string): NormalisedProperty | undefined {
    return this.catalog
      .getDevice(plan.sourceId, plan.deviceId)
      ?.properties.find((property) => property.key === key);
  }

  private serviceType(tile: TileType): WithUUID<typeof Service> {
    const { Service } = this.api.hap;
    switch (tile) {
      case 'Outlet':
        return Service.Outlet;
      case 'Lightbulb':
        return Service.Lightbulb;
      case 'Fan':
        return Service.Fan;
      case 'Switch':
      default:
        return Service.Switch;
    }
  }
}
