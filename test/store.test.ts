import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { silentLogger } from '../src/logger.js';
import { Store, storeFile } from '../src/store.js';

async function temporaryFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mq77-customizer-'));
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

describe('keeping a way back', () => {
  it('keeps what it found at startup, whatever happens afterwards', async () => {
    const file = await temporaryFile();
    const first = new Store(file, silentLogger);
    await first.load();
    first.update((state) => {
      state.rules = [{ id: 'r1', name: 'First', enabled: true } as never];
    });
    await first.save();

    // A later run that loses everything, however it managed to.
    const second = new Store(file, silentLogger);
    await second.load();
    second.update((state) => {
      state.rules = [];
      state.exposures = {};
    });
    await second.save();
    await second.save();

    // Copied at startup, before this run touched anything, so repeated
    // writes cannot replace the good copy with the empty one.
    const folder = join(dirname(file), 'backups');
    const copies = (await readdir(folder)).filter((name) => name.startsWith('state-'));
    expect(copies.length).toBeGreaterThan(0);

    const kept = JSON.parse(
      await readFile(join(folder, copies.sort().at(-1)!), 'utf8'),
    ) as { rules: unknown[] };
    expect(kept.rules).toHaveLength(1);
  });

  it('lets somebody empty their own settings', async () => {
    const file = await temporaryFile();
    const first = new Store(file, silentLogger);
    await first.load();
    first.update((state) => {
      state.rules = [{ id: 'r1', name: 'First', enabled: true } as never];
    });
    await first.save();

    // This run read them, so deleting them is a decision rather than a fault.
    const second = new Store(file, silentLogger);
    await second.load();
    second.update((state) => {
      state.rules = [];
    });
    await second.save();

    const written = JSON.parse(await readFile(file, 'utf8')) as { rules: unknown[] };
    expect(written.rules).toEqual([]);
    expect(second.refusedToWrite).toBe(false);
  });

  it('refuses to write nothing over something it never read', async () => {
    const file = await temporaryFile();
    const first = new Store(file, silentLogger);
    await first.load();
    first.update((state) => {
      state.rules = [{ id: 'r1', name: 'First', enabled: true } as never];
    });
    await first.save();

    // A run that began with nothing, as one looking at the wrong file would.
    const stray = new Store(`${file}.missing`, silentLogger);
    await stray.load();
    // Pointed at the real file after the fact, which is the shape of the
    // fault: everything configured is there, and this run knows none of it.
    const blind = new Store(file, silentLogger);
    Object.assign(blind, { startedFull: false });
    await blind.save();

    const kept = JSON.parse(await readFile(file, 'utf8')) as { rules: unknown[] };
    expect(kept.rules).toHaveLength(1);
    expect(blind.refusedToWrite).toBe(true);
    expect(stray).toBeDefined();
  });

  it('keeps ten copies and no more', async () => {
    const file = await temporaryFile();
    const store = new Store(file, silentLogger);
    await store.load();
    store.update((state) => {
      state.rules = [{ id: 'r1', name: 'First', enabled: true } as never];
    });
    await store.save();

    const folder = join(dirname(file), 'backups');
    await mkdir(folder, { recursive: true });
    for (let index = 0; index < 15; index++) {
      await writeFile(join(folder, `state-2020-01-01-00-${String(index).padStart(2, '0')}.json`), '{}');
    }

    // A copy is only taken when one is due, so this one is asked for.
    await (store as unknown as { backup: (force: boolean) => Promise<void> }).backup(true);

    const copies = (await readdir(folder)).filter((name) => name.startsWith('state-'));
    expect(copies).toHaveLength(10);
  });

  it('puts a settings file back, keeping the session secret', async () => {
    const file = await temporaryFile();
    const store = new Store(file, silentLogger);
    await store.load();
    const secret = store.sessionSecret();

    await store.replaceAll({
      exposures: { 'zigbee:0xa': { properties: ['state'] } },
      rules: [{ id: 'r9', name: 'From a file', enabled: true }],
    });

    expect(store.data.rules).toHaveLength(1);
    expect(Object.keys(store.data.exposures)).toEqual(['zigbee:0xa']);
    // Replacing the secret would sign everybody out of the interface.
    expect(store.sessionSecret()).toBe(secret);
  });

  it('does not mind there being nothing to back up yet', async () => {
    const file = await temporaryFile();
    const store = new Store(file, silentLogger);
    await store.load();
    store.update((state) => {
      state.exposures['a:b'] = { properties: [] };
    });
    await expect(store.save()).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ exposures: { 'a:b': {} } });
  });
});

describe('adopting state from the previous plugin name', () => {
  it('takes over the older file when there is no current one', async () => {
    const legacy = await temporaryFile();
    const first = new Store(legacy, silentLogger);
    await first.load();
    first.update((state) => {
      state.exposures['zigbee:0x1'] = { properties: ['state_l1'] };
    });
    await first.save();

    const current = await temporaryFile();
    const store = new Store(current, silentLogger, legacy);
    await store.load();

    // A rename must not silently discard everything the user had ticked.
    expect(store.data.exposures['zigbee:0x1']).toEqual({ properties: ['state_l1'] });
    expect(JSON.parse(await readFile(current, 'utf8'))).toMatchObject({
      exposures: { 'zigbee:0x1': { properties: ['state_l1'] } },
    });
  });

  it('leaves the older file in place, so downgrading still works', async () => {
    const legacy = await temporaryFile();
    await writeFile(legacy, JSON.stringify({ version: 1, exposures: {}, rules: [] }), 'utf8');

    const store = new Store(await temporaryFile(), silentLogger, legacy);
    await store.load();

    expect(await readFile(legacy, 'utf8')).toContain('"exposures"');
  });

  it('prefers the current file when both exist', async () => {
    const legacy = await temporaryFile();
    await writeFile(legacy, JSON.stringify({ exposures: { old: { properties: ['a'] } } }), 'utf8');
    const current = await temporaryFile();
    await writeFile(current, JSON.stringify({ exposures: { current: { properties: ['b'] } } }), 'utf8');

    const store = new Store(current, silentLogger, legacy);
    await store.load();

    expect(Object.keys(store.data.exposures)).toEqual(['current']);
  });

  it('starts fresh when neither exists', async () => {
    const store = new Store(await temporaryFile(), silentLogger, await temporaryFile());
    await store.load();
    expect(store.data.exposures).toEqual({});
  });
});

describe('storeFile', () => {
  it('lives under the Homebridge storage path', () => {
    expect(storeFile('/var/lib/homebridge', 'mq77-customizer')).toBe(
      '/var/lib/homebridge/mq77-customizer/state.json',
    );
  });
});
