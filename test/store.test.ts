import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { silentLogger } from '../src/logger.js';
import { Store, storeFile } from '../src/store.js';

async function temporaryFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mqtt-customizer-'));
  return join(directory, 'state.json');
}

describe('Store', () => {
  it('starts empty when there is no file yet', async () => {
    const store = new Store(await temporaryFile(), silentLogger);
    await store.load();
    expect(store.data).toEqual({ version: 1, exposures: {}, rules: [] });
  });

  it('creates the directory on first write', async () => {
    const file = join(await temporaryFile(), '..', 'nested', 'state.json');
    const store = new Store(file, silentLogger);
    await store.load();
    store.update((state) => {
      state.exposures['zigbee:0x1'] = { properties: ['state'] };
    });
    await store.save();

    const written: unknown = JSON.parse(await readFile(file, 'utf8'));
    expect(written).toMatchObject({ exposures: { 'zigbee:0x1': { properties: ['state'] } } });
  });

  it('round trips saved state', async () => {
    const file = await temporaryFile();
    const first = new Store(file, silentLogger);
    await first.load();
    first.update((state) => {
      state.exposures['zigbee:0x1'] = { properties: ['state_l1'], splitEndpoints: true };
    });
    await first.save();

    const second = new Store(file, silentLogger);
    await second.load();
    expect(second.data.exposures['zigbee:0x1']).toEqual({
      properties: ['state_l1'],
      splitEndpoints: true,
    });
  });

  it('refuses to start on an unreadable file instead of overwriting it', async () => {
    const file = await temporaryFile();
    await writeFile(file, '{ this is not json', 'utf8');
    const store = new Store(file, silentLogger);
    await expect(store.load()).rejects.toThrow(/Could not read/);
    // The damaged file must still be there for the user to recover.
    expect(await readFile(file, 'utf8')).toBe('{ this is not json');
  });

  it('fills in missing sections from an older file', async () => {
    const file = await temporaryFile();
    await writeFile(file, JSON.stringify({ version: 1 }), 'utf8');
    const store = new Store(file, silentLogger);
    await store.load();
    expect(store.data).toEqual({ version: 1, exposures: {}, rules: [] });
  });
});

describe('storeFile', () => {
  it('lives under the Homebridge storage path', () => {
    expect(storeFile('/var/lib/homebridge', 'mqtt-customizer')).toBe(
      '/var/lib/homebridge/mqtt-customizer/state.json',
    );
  });
});
