import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Characteristic, Service } from 'hap-nodejs';
import { describe, expect, it } from 'vitest';

import { Catalog } from '../src/catalog.js';
import { AccessoryManager } from '../src/homekit/manager.js';
import { planAccessories } from '../src/homekit/mapping.js';
import { isPublishable, roleFor } from '../src/homekit/roles.js';
import { toHomeKit } from '../src/homekit/values.js';
import { silentLogger } from '../src/logger.js';
import type { NormalisedProperty } from '../src/model/types.js';
import { Store } from '../src/store.js';
import { fakeApi } from './helpers/fake-homebridge.js';
import { FakeMqtt } from './helpers/fake-mqtt.js';

const reading = (key: string, unit?: string): NormalisedProperty => ({
  key,
  label: key,
  semantic: key,
  type: 'numeric',
  access: { readable: true, writable: false },
  category: 'primary',
  ...(unit ? { unit } : {}),
  stateTopic: 'zigbee2mqtt/device',
  extract: [key],
});

describe('a light reading', () => {
  it('is a light sensor when it is in lux, whatever it is called', () => {
    expect(roleFor(reading('illuminance', 'lx'))).toBe('illuminance');
    expect(roleFor(reading('illuminance_lux', 'lx'))).toBe('illuminance');
  });

  it('is nothing to HomeKit when it is a raw number', () => {
    // What Zigbee2MQTT 1.x called the Hue sensor's raw reading.
    expect(roleFor(reading('illuminance'))).toBeUndefined();
    expect(isPublishable(reading('illuminance'))).toBe(false);
  });

  it('goes to HomeKit within the range it takes, which has no darkness', () => {
    expect(toHomeKit('CurrentAmbientLightLevel', reading('illuminance', 'lx'), 49)).toBe(49);
    expect(toHomeKit('CurrentAmbientLightLevel', reading('illuminance', 'lx'), 0)).toBe(0.0001);
    expect(toHomeKit('CurrentAmbientLightLevel', reading('illuminance', 'lx'), 250_000)).toBe(100_000);
  });
});

describe('a motion sensor that measures light', () => {
  const device = (properties: NormalisedProperty[]) => ({
    sourceId: 'zigbee',
    deviceId: '0xhue',
    name: 'Hal',
    rulesOnly: false,
    renameable: false,
    properties: [
      { ...reading('occupancy'), type: 'binary' as const, onValue: true, offValue: false },
      ...properties,
    ],
  });

  it('is a motion sensor first, with a light sensor beside it', () => {
    const plans = planAccessories(device([reading('illuminance', 'lx')]), {
      properties: ['occupancy', 'illuminance'],
    });
    expect(plans[0]?.services.map((service) => service.kind)).toEqual(['MotionSensor', 'LightSensor']);
    expect(plans[0]?.services[1]?.bindings[0]?.characteristic).toBe('CurrentAmbientLightLevel');
  });

  it('gets one light level where it reports two in lux, the one named so', () => {
    const plans = planAccessories(
      device([reading('illuminance', 'lx'), reading('illuminance_lux', 'lx')]),
      { properties: ['occupancy', 'illuminance', 'illuminance_lux'] },
    );
    const light = plans[0]?.services.filter((service) => service.kind === 'LightSensor');
    expect(light).toHaveLength(1);
    expect(light?.[0]?.bindings[0]?.propertyKey).toBe('illuminance_lux');
  });
});

describe('in HomeKit', () => {
  it('shows what the sensor says, in lux', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mq77-light-'));
    const store = new Store(join(directory, 'state.json'), silentLogger);
    await store.load();
    const mqtt = new FakeMqtt();
    const catalog = new Catalog(mqtt.asConnection(), silentLogger);
    await catalog.start([{ id: 'zigbee', adapter: 'zigbee2mqtt', baseTopic: 'zigbee2mqtt' }]);
    // A Hue motion sensor as Zigbee2MQTT 2.x describes it.
    mqtt.deliver(
      'zigbee2mqtt/bridge/devices',
      [
        {
          friendly_name: 'hall_motion-hue',
          ieee_address: '0x0017880100000001',
          interview_completed: true,
          supported: true,
          type: 'EndDevice',
          definition: {
            model: 'SML002',
            vendor: 'Philips',
            description: 'Hue motion outdoor sensor',
            exposes: [
              { type: 'binary', name: 'occupancy', property: 'occupancy', access: 1, value_on: true, value_off: false },
              { type: 'numeric', name: 'illuminance', property: 'illuminance', access: 1, unit: 'lx' },
            ],
            options: [],
          },
        },
      ],
      { retained: true },
    );
    const hb = fakeApi();
    const manager = new AccessoryManager(hb.api, silentLogger, catalog, store, mqtt.asConnection());
    catalog.on('state', (update) => manager.handleState(update));
    store.setExposure('zigbee:0x0017880100000001', { properties: ['occupancy', 'illuminance'] });
    manager.sync();

    mqtt.deliver('zigbee2mqtt/hall_motion-hue', {
      battery: 100,
      illuminance: 49,
      illumination_compensation_offset: 0,
      occupancy: false,
      pir_occupied_to_unoccupied_delay: 5,
    });

    const accessory = hb.registered[0]!;
    expect(
      accessory.getService(Service.LightSensor)?.getCharacteristic(Characteristic.CurrentAmbientLightLevel).value,
    ).toBe(49);
  });
});

describe('in the device list', () => {
  it('says a reading in lux becomes a light sensor, and offers no tick for a raw one', async () => {
    const { openInterface } = await import('./helpers/interface.js');
    const property = (key: string, publishable: boolean, role?: string) => ({
      key,
      label: key,
      semantic: key,
      type: 'numeric',
      category: 'primary',
      endpoint: '',
      readable: true,
      writable: false,
      publishable,
      ...(role ? { role } : {}),
    });
    const ui = await openInterface({
      state: {
        devices: [
          {
            sourceId: 'zigbee',
            deviceId: '0xhue',
            name: 'hall_motion-hue',
            topic: 'zigbee2mqtt/hall_motion-hue',
            rulesOnly: false,
            renameable: false,
            endpoints: [''],
            properties: [property('illuminance_lux', true, 'illuminance'), property('illuminance', false)],
            exposure: { properties: [], type: 'sensor' },
            state: { illuminance_lux: 49, illuminance: 16990 },
            lastSeen: {},
          },
        ],
      },
    });
    const card = ui.document.querySelector('#devices details.device') as HTMLDetailsElement;
    await ui.openCard(card);
    expect(card.querySelector('[data-role-tag$="|illuminance_lux"]')?.textContent).toBe('light sensor');
    // Only the reading in lux can be ticked for HomeKit.
    const ticks = [...card.querySelectorAll('input[type=checkbox]:not(:disabled)')].map((box) => box.id);
    expect(ticks).toEqual(['p-zigbee:0xhue-illuminance_lux']);
  });
});
