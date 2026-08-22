import { describe, expect, it } from 'vitest';

import { resolveConfig } from '../src/config.js';
import type { Logger } from '../src/logger.js';

function collectingLogger(): Logger & { errors: string[] } {
  const errors: string[] = [];
  return {
    errors,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (message) => errors.push(message),
  };
}

describe('resolveConfig', () => {
  it('fills in broker and web defaults', () => {
    const config = resolveConfig({}, collectingLogger());
    expect(config.broker).toMatchObject({ host: 'localhost', port: 1883 });
    expect(config.web.port).toBe(8888);
  });

  it('splits the broker address into host and port', () => {
    const config = resolveConfig({ broker: { address: '192.168.1.5:1884' } }, collectingLogger());
    expect(config.broker).toMatchObject({ host: '192.168.1.5', port: 1884 });
  });

  it('still reads a host and port stored separately, so an upgrade keeps working', () => {
    const config = resolveConfig({ broker: { host: 'pi.local', port: 1884 } }, collectingLogger());
    expect(config.broker).toMatchObject({ host: 'pi.local', port: 1884 });
  });

  it('prefers the address over any leftover host and port', () => {
    const config = resolveConfig(
      { broker: { address: 'new.local:1885', host: 'old.local', port: 1884 } },
      collectingLogger(),
    );
    expect(config.broker).toMatchObject({ host: 'new.local', port: 1885 });
  });

  it('falls back to the defaults when the address makes no sense', () => {
    const config = resolveConfig({ broker: { address: 'pi.local:nope' } }, collectingLogger());
    expect(config.broker).toMatchObject({ host: 'localhost', port: 1883 });
  });

  it('sends credentials only when authentication is asked for', () => {
    const credentials = { address: 'localhost:1883', username: 'mqtt', password: 'secret' };

    const off = resolveConfig({ broker: credentials }, collectingLogger());
    expect(off.broker.username).toBeUndefined();
    expect(off.broker.password).toBeUndefined();

    const on = resolveConfig(
      { broker: { ...credentials, requiresAuth: true } },
      collectingLogger(),
    );
    expect(on.broker).toMatchObject({ username: 'mqtt', password: 'secret' });
  });

  it('defaults to a single Zigbee2MQTT source when none are given', () => {
    const config = resolveConfig({}, collectingLogger());
    expect(config.sources).toEqual([
      { id: 'zigbee2mqtt', adapter: 'zigbee2mqtt', baseTopic: 'zigbee2mqtt' },
    ]);
  });

  it('keeps an explicitly empty source list empty', () => {
    const config = resolveConfig({ sources: [] }, collectingLogger());
    expect(config.sources).toEqual([]);
  });

  it('skips sources missing required fields rather than failing', () => {
    const log = collectingLogger();
    const config = resolveConfig(
      {
        sources: [
          { id: 'good', adapter: 'zigbee2mqtt', baseTopic: 'zigbee2mqtt' },
          { id: 'nobase', adapter: 'zigbee2mqtt' },
        ],
      },
      log,
    );
    expect(config.sources.map((source) => source.id)).toEqual(['good']);
    expect(log.errors).toHaveLength(1);
  });

  it('reads devices described by hand', () => {
    const config = resolveConfig(
      {
        sources: [
          {
            id: 'broadlink',
            adapter: 'json-topic',
            baseTopic: 'broadlinkrm',
            devices: [{ topic: 'fan_office', properties: ['speed', 'swing'] }],
          },
        ],
      },
      collectingLogger(),
    );
    expect(config.sources[0]?.devices).toEqual([
      { topic: 'fan_office', properties: ['speed', 'swing'] },
    ]);
  });

  it('skips a described device with no topic or no functions, keeping the rest', () => {
    const log = collectingLogger();
    const config = resolveConfig(
      {
        sources: [
          {
            id: 'broadlink',
            adapter: 'json-topic',
            baseTopic: 'broadlinkrm',
            devices: [
              { properties: ['speed'] },
              { topic: 'empty', properties: [] },
              { topic: 'fan_office', properties: ['speed'] },
            ],
          },
        ],
      },
      log,
    );
    expect(config.sources[0]?.devices).toEqual([{ topic: 'fan_office', properties: ['speed'] }]);
    expect(log.errors).toHaveLength(2);
  });

  it('leaves devices unset when none are described', () => {
    const config = resolveConfig(
      { sources: [{ id: 'z', adapter: 'zigbee2mqtt', baseTopic: 'zigbee2mqtt' }] },
      collectingLogger(),
    );
    expect(config.sources[0]?.devices).toBeUndefined();
  });

  it('skips unknown adapters and says what is available', () => {
    const log = collectingLogger();
    const config = resolveConfig(
      { sources: [{ id: 'x', adapter: 'carrier-pigeon', baseTopic: 'broadlinkrm' }] },
      log,
    );
    expect(config.sources).toEqual([]);
    expect(log.errors[0]).toContain('zigbee2mqtt');
  });

  it('skips duplicate source ids', () => {
    const log = collectingLogger();
    const config = resolveConfig(
      {
        sources: [
          { id: 'a', adapter: 'zigbee2mqtt', baseTopic: 'one' },
          { id: 'a', adapter: 'zigbee2mqtt', baseTopic: 'two' },
        ],
      },
      log,
    );
    expect(config.sources).toHaveLength(1);
    expect(config.sources[0]?.baseTopic).toBe('one');
    expect(log.errors).toHaveLength(1);
  });

  it('treats a blank web password as none, rather than an untypeable secret', () => {
    expect(resolveConfig({ web: { password: '   ' } }, collectingLogger()).web.password).toBeUndefined();
    expect(resolveConfig({ web: { password: '' } }, collectingLogger()).web.password).toBeUndefined();
    expect(resolveConfig({ web: { password: ' hunter2 ' } }, collectingLogger()).web.password).toBe('hunter2');
  });

  it('takes a Zigbee2MQTT address a browser can open', () => {
    const log = collectingLogger();
    expect(
      resolveConfig({ web: { zigbee2mqttUrl: 'http://pi.local:8080' } }, log).web.zigbee2mqttUrl,
    ).toBe('http://pi.local:8080/');
    expect(log.errors).toEqual([]);
  });

  it('refuses one it would only render as a broken link', () => {
    for (const address of ['pi.local:8080', 'javascript:alert(1)', 'not a url', 'file:///etc']) {
      expect(
        resolveConfig({ web: { zigbee2mqttUrl: address } }, collectingLogger()).web.zigbee2mqttUrl,
      ).toBeUndefined();
    }
  });

  it('is happy without one', () => {
    expect(resolveConfig({}, collectingLogger()).web.zigbee2mqttUrl).toBeUndefined();
    expect(resolveConfig({ web: { zigbee2mqttUrl: '  ' } }, collectingLogger()).web.zigbee2mqttUrl).toBeUndefined();
  });

  it('reads rulesOnly', () => {
    const config = resolveConfig(
      { sources: [{ id: 'a', adapter: 'zigbee2mqtt', baseTopic: 'one', rulesOnly: true }] },
      collectingLogger(),
    );
    expect(config.sources[0]?.rulesOnly).toBe(true);
  });
});
