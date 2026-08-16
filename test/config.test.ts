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
    expect(config.web.port).toBe(8590);
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

  it('skips unknown adapters and says what is available', () => {
    const log = collectingLogger();
    const config = resolveConfig(
      { sources: [{ id: 'x', adapter: 'json-topic', baseTopic: 'broadlinkrm' }] },
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

  it('reads rulesOnly', () => {
    const config = resolveConfig(
      { sources: [{ id: 'a', adapter: 'zigbee2mqtt', baseTopic: 'one', rulesOnly: true }] },
      collectingLogger(),
    );
    expect(config.sources[0]?.rulesOnly).toBe(true);
  });
});
