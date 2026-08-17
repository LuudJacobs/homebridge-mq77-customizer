import type { API, PlatformAccessory } from 'homebridge';
// Real HAP objects rather than a hand written fake, so the service and
// characteristic behaviour the manager relies on is the behaviour Homebridge
// will actually give it.
import { Characteristic, HAPStatus, HapStatusError, Service, uuid } from 'hap-nodejs';
import { PlatformAccessory as HomebridgePlatformAccessory } from 'homebridge/lib/platformAccessory.js';

export interface FakeApi {
  api: API;
  registered: PlatformAccessory[];
  unregistered: PlatformAccessory[];
}

export function fakeApi(): FakeApi {
  const registered: PlatformAccessory[] = [];
  const unregistered: PlatformAccessory[] = [];

  const api = {
    hap: { uuid, Service, Characteristic, HapStatusError, HAPStatus },
    platformAccessory: HomebridgePlatformAccessory,
    registerPlatformAccessories: (_plugin: string, _platform: string, accessories: PlatformAccessory[]) => {
      registered.push(...accessories);
    },
    unregisterPlatformAccessories: (
      _plugin: string,
      _platform: string,
      accessories: PlatformAccessory[],
    ) => {
      unregistered.push(...accessories);
    },
  } as unknown as API;

  return { api, registered, unregistered };
}

/** Builds an accessory the way Homebridge would when restoring from its cache. */
export function cachedAccessory(name: string, seed: string): PlatformAccessory {
  return new HomebridgePlatformAccessory(name, uuid.generate(seed)) as unknown as PlatformAccessory;
}
