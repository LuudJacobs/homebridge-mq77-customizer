import { describe, expect, it, vi } from 'vitest';

import { Zigbee2mqttAdapter, readNetworkMap } from '../src/adapters/zigbee2mqtt/adapter.js';
import { silentLogger } from '../src/logger.js';
import { FakeMqtt } from './helpers/fake-mqtt.js';

const BASE = 'zigbee2mqtt';
const REQUEST = `${BASE}/bridge/request/networkmap`;
const RESPONSE = `${BASE}/bridge/response/networkmap`;

const node = (address: string, name: string, type: string, extra = {}) => ({
  ieeeAddr: address,
  friendlyName: name,
  type,
  ...extra,
});

const link = (from: string, to: string, quality: number) => ({
  source: { ieeeAddr: from },
  target: { ieeeAddr: to },
  linkquality: quality,
});

/** A hub, a router hanging off it, and a sensor behind the router. */
const SCAN = {
  status: 'ok',
  data: {
    type: 'raw',
    value: {
      nodes: [
        node('0x001', 'Coordinator', 'Coordinator'),
        node('0x002', 'hall_socket', 'Router'),
        node('0x003', 'shed_sensor', 'EndDevice'),
      ],
      links: [link('0x001', '0x002', 200), link('0x002', '0x003', 90)],
    },
  },
};

async function makeAdapter() {
  const mqtt = new FakeMqtt();
  const adapter = new Zigbee2mqttAdapter({
    source: { id: 'zigbee', adapter: 'zigbee2mqtt', baseTopic: BASE },
    mqtt: mqtt.asConnection(),
    log: silentLogger,
  });
  await adapter.start();
  return { adapter, mqtt };
}

describe('asking for the network map', () => {
  it('asks the bridge for a raw scan', async () => {
    const { adapter, mqtt } = await makeAdapter();
    const pending = adapter.getNetworkMap();

    const asked = mqtt.published.find((message) => message.topic === REQUEST);
    expect(asked).toBeDefined();
    expect(JSON.parse(asked!.payload)).toMatchObject({ type: 'raw' });

    mqtt.deliver(RESPONSE, SCAN);
    await expect(pending).resolves.toMatchObject({ nodes: expect.any(Array) });
  });

  it('answers with what the scan found', async () => {
    const { adapter, mqtt } = await makeAdapter();
    const pending = adapter.getNetworkMap();
    mqtt.deliver(RESPONSE, SCAN);

    const map = await pending;
    expect(map.nodes.map((entry) => entry.name)).toEqual([
      'Coordinator',
      'hall_socket',
      'shed_sensor',
    ]);
    expect(map.nodes.map((entry) => entry.kind)).toEqual(['coordinator', 'router', 'end device']);
    expect(map.links).toHaveLength(2);
  });

  it('makes two askers wait on one scan', async () => {
    const { adapter, mqtt } = await makeAdapter();
    const first = adapter.getNetworkMap();
    const second = adapter.getNetworkMap();

    // A scan is expensive enough that asking twice must not run it twice.
    expect(mqtt.published.filter((message) => message.topic === REQUEST)).toHaveLength(1);

    mqtt.deliver(RESPONSE, SCAN);
    expect(await first).toEqual(await second);
  });

  it('gives up rather than waiting for ever', async () => {
    vi.useFakeTimers();
    try {
      const { adapter } = await makeAdapter();
      const settled = adapter.getNetworkMap().catch((error: Error) => error.message);

      await vi.advanceTimersByTimeAsync(200_000);
      expect(await settled).toContain('did not answer');
    } finally {
      vi.useRealTimers();
    }
  });

  it('can be asked again after one failed', async () => {
    const { adapter, mqtt } = await makeAdapter();
    const first = adapter.getNetworkMap().catch(() => 'failed');
    mqtt.deliver(RESPONSE, { status: 'error', error: 'busy' });
    expect(await first).toBe('failed');

    // The failure must not leave the adapter thinking a scan is still running.
    const second = adapter.getNetworkMap();
    mqtt.deliver(RESPONSE, SCAN);
    expect((await second).nodes).toHaveLength(3);
  });

  it('says so when the bridge refuses', async () => {
    const { adapter, mqtt } = await makeAdapter();
    const pending = adapter.getNetworkMap();
    mqtt.deliver(RESPONSE, { status: 'error', error: 'coordinator is busy' });

    await expect(pending).rejects.toThrow(/coordinator is busy/);
  });

  it('ignores an answer nobody is waiting for', async () => {
    const { mqtt } = await makeAdapter();
    // Another client can ask, and the reply is published to everyone.
    expect(() => mqtt.deliver(RESPONSE, SCAN)).not.toThrow();
  });
});

describe('reading a raw scan', () => {
  it('keeps one line for a link both ends report', () => {
    const map = readNetworkMap(
      [node('0x001', 'a', 'Coordinator'), node('0x002', 'b', 'Router')],
      [link('0x001', '0x002', 200), link('0x002', '0x001', 190)],
    );
    expect(map.links).toHaveLength(1);
  });

  it('drops a link to a device the scan did not report', () => {
    const map = readNetworkMap([node('0x001', 'a', 'Coordinator')], [link('0x001', '0x009', 200)]);
    // A line to nothing cannot be drawn, and usually means a device that left.
    expect(map.links).toEqual([]);
  });

  it('reads the older shape, where the address is on the link itself', () => {
    const map = readNetworkMap(
      [node('0x001', 'a', 'Coordinator'), node('0x002', 'b', 'Router')],
      [{ sourceIeeeAddr: '0x001', targetIeeeAddr: '0x002', linkquality: 40 }],
    );
    expect(map.links).toEqual([{ from: '0x001', to: '0x002', quality: 40 }]);
  });

  it('marks a device that did not answer', () => {
    const map = readNetworkMap([node('0x002', 'b', 'Router', { failed: ['lqi'] })], []);
    expect(map.nodes[0]).toMatchObject({ failed: true });
  });

  it('falls back to the address when a device has no name', () => {
    const map = readNetworkMap([{ ieeeAddr: '0x004', type: 'Router' }], []);
    expect(map.nodes[0]?.name).toBe('0x004');
  });

  it('skips anything without an address, rather than drawing a blank', () => {
    const map = readNetworkMap([{ friendlyName: 'nameless' }, node('0x001', 'a', 'Router')], []);
    expect(map.nodes).toHaveLength(1);
  });
});
