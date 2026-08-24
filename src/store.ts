import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Logger } from './logger.js';
import type { AnyRule } from './rules/types.js';

/** Bumped when the shape changes in a way that needs migrating. */
export const STORE_VERSION = 1;

export type { AnyRule, MirrorRule, Rule } from './rules/types.js';

/** HomeKit service a binary on/off property is published as. */
export type TileType = 'Switch' | 'Outlet' | 'Lightbulb' | 'Fan';

export const TILE_TYPES: TileType[] = ['Switch', 'Outlet', 'Lightbulb', 'Fan'];

/** Endpoint key used for properties that belong to the device as a whole. */
export const DEVICE_ENDPOINT = '';

/** What the user ticked for one device. */
/** The kinds a device can be marked as, for grouping it in the interface. */
export const DEVICE_TYPES = [
  'light',
  'sensor',
  'controller',
  'fan',
  'tv',
  'audio',
  'media',
  'other',
] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

export interface DeviceExposure {
  /** Property keys published to HomeKit. Everything else stays rules only. */
  properties: string[];
  /** Tile to use for a binary on/off property, keyed by endpoint. */
  tileTypes?: Record<string, TileType>;
  /** Publish each endpoint as its own accessory rather than one with several services. */
  splitEndpoints?: boolean;
  /**
   * A name for the device itself, used in the interface and as the base for
   * accessory names. Only offered for sources that do not name devices
   * themselves.
   */
  label?: string;
  /**
   * Where the device is, for grouping in the interface.
   *
   * The interface only: HomeKit rooms belong to the Home app, which no
   * accessory can set or read.
   */
  room?: string;
  /** What sort of thing it is, for grouping and an icon in the interface. */
  type?: DeviceType;
  /** Accessory name overrides, keyed by endpoint. */
  names?: Record<string, string>;
  /**
   * Which button gestures reach HomeKit, keyed by action property then button
   * name, holding the HomeKit event numbers to keep.
   *
   * An absent button means every gesture it supports, so a device paired
   * before this existed keeps working.
   */
  buttons?: Record<string, Record<string, number[]>>;
}


export interface PersistedState {
  version: number;
  /** Keyed `sourceId:deviceId`. */
  exposures: Record<string, DeviceExposure>;
  rules: AnyRule[];
  /** Signs web session cookies. Generated on first run so logins survive restarts. */
  sessionSecret?: string;
}

function emptyState(): PersistedState {
  return { version: STORE_VERSION, exposures: {}, rules: [] };
}

/**
 * Persisted state, kept out of config.json.
 *
 * Homebridge UI owns config.json and rewrites it wholesale, so anything we
 * change at runtime would race it. Living in the storage path also means
 * ticking a checkbox never asks for a Homebridge restart.
 */
/** How many dated copies to keep. Small files, so this is generous. */
const BACKUPS_KEPT = 10;
/** Shortest gap between copies, so a busy hour leaves one and not fifty. */
const BACKUP_EVERY_MS = 60 * 60 * 1000;

export class Store {
  private state: PersistedState = emptyState();
  private writing?: Promise<void>;
  private dirty = false;
  /** Whether this run started from a file with anything in it. */
  private startedFull = false;
  /** Set when a write was refused, so the interface can say so. */
  private blocked = false;
  /** When the last dated copy was taken, for saying so in the interface. */
  private backupAt?: number;

  constructor(
    private readonly file: string,
    private readonly log: Logger,
    /** Older location to adopt from, used once after the plugin was renamed. */
    private readonly legacyFile?: string,
  ) {}

  async load(): Promise<void> {
    try {
      const contents = await readFile(this.file, 'utf8');
      const parsed: unknown = JSON.parse(contents);
      this.state = migrate(parsed);

      this.startedFull =
        Object.keys(this.state.exposures).length > 0 || this.state.rules.length > 0;

      // A dated copy of what was here before this run touches anything.
      await this.backup();

      // Counted out loud, so state quietly arriving empty is visible in the
      // log rather than only noticed when something is missing.
      this.log.info(
        `Loaded ${Object.keys(this.state.exposures).length} device selection(s) and ` +
          `${this.state.rules.length} rule(s) from ${this.file}`,
      );
    } catch (error) {
      if (isNotFound(error)) {
        if (await this.adoptLegacy()) {
          return;
        }
        this.log.info(`No saved state yet, starting fresh (${this.file})`);
        this.state = emptyState();
        return;
      }
      // Refuse to silently start empty, that would drop the user's setup and
      // then overwrite the file they could have recovered it from.
      throw new Error(`Could not read ${this.file}: ${describe(error)}`);
    }
  }

  /**
   * Takes over state written under the plugin's previous name.
   *
   * The old file is left alone rather than moved, so downgrading is still
   * possible and a failed adoption cannot lose it.
   */
  private async adoptLegacy(): Promise<boolean> {
    if (!this.legacyFile) {
      return false;
    }
    try {
      const contents = await readFile(this.legacyFile, 'utf8');
      this.state = migrate(JSON.parse(contents) as unknown);
      this.log.info(`Adopted saved state from ${this.legacyFile}`);
      await this.save();
      return true;
    } catch (error) {
      if (!isNotFound(error)) {
        this.log.warn(`Could not read the older state at ${this.legacyFile}: ${describe(error)}`);
      }
      return false;
    }
  }

  get data(): Readonly<PersistedState> {
    return this.state;
  }

  getExposure(key: string): DeviceExposure | undefined {
    return this.state.exposures[key];
  }

  setExposure(key: string, exposure: DeviceExposure): void {
    this.update((state) => {
      state.exposures[key] = exposure;
    });
  }

  /** Returns the session secret, generating and persisting one on first use. */
  sessionSecret(): string {
    if (!this.state.sessionSecret) {
      this.update((state) => {
        state.sessionSecret = randomBytes(32).toString('hex');
      });
    }
    return this.state.sessionSecret as string;
  }

  update(mutate: (state: PersistedState) => void): void {
    mutate(this.state);
    void this.save();
  }

  /** When the last dated copy was taken, if any. */
  lastBackup(): number | undefined {
    return this.backupAt;
  }

  /** True once a write has been refused to protect the file. */
  get refusedToWrite(): boolean {
    return this.blocked;
  }

  /** Replaces everything, keeping the secret that signs the session cookie. */
  async replaceAll(incoming: unknown): Promise<void> {
    const parsed = migrate(incoming);
    await this.backup(true);
    this.state = { ...parsed, sessionSecret: this.state.sessionSecret };
    this.startedFull =
      Object.keys(this.state.exposures).length > 0 || this.state.rules.length > 0;
    this.blocked = false;
    await this.save();
  }

  /**
   * Keeps a dated copy of the file, and thins the older ones out.
   *
   * One copy per hour at most: a busy afternoon should leave a trail worth
   * walking back along, not fifty files a minute apart.
   */
  private async backup(force = false): Promise<void> {
    if (!force && this.backupAt !== undefined && Date.now() - this.backupAt < BACKUP_EVERY_MS) {
      return;
    }

    const folder = join(dirname(this.file), 'backups');
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

    try {
      await mkdir(folder, { recursive: true });
      await copyFile(this.file, join(folder, `state-${stamp}.json`));
      this.backupAt = Date.now();

      // Oldest first by name, since the stamp sorts the way time runs.
      const kept = (await readdir(folder))
        .filter((name) => name.startsWith('state-') && name.endsWith('.json'))
        .sort();
      for (const name of kept.slice(0, Math.max(0, kept.length - BACKUPS_KEPT))) {
        await rm(join(folder, name)).catch(() => {});
      }
    } catch (error) {
      this.log.warn(`Could not keep a backup of ${this.file}: ${describe(error)}`);
    }
  }

  /**
   * Refuses to write nothing over something.
   *
   * Only when this run began with nothing. Somebody deleting their last rule
   * by hand is entitled to an empty file, but a run that started empty and is
   * about to stamp on a file that is not has misread something, and the file
   * is worth more than the write.
   */
  private async wouldWipe(): Promise<boolean> {
    const empty =
      Object.keys(this.state.exposures).length === 0 && this.state.rules.length === 0;
    if (this.startedFull || !empty) {
      return false;
    }

    try {
      const parsed = migrate(JSON.parse(await readFile(this.file, 'utf8')) as unknown);
      return Object.keys(parsed.exposures).length > 0 || parsed.rules.length > 0;
    } catch {
      // Nothing readable there, so there is nothing to protect.
      return false;
    }
  }

  /** Writes via a temporary file so a crash mid write cannot truncate state. */
  async save(): Promise<void> {
    this.dirty = true;
    if (this.writing) {
      return this.writing;
    }

    this.writing = (async () => {
      while (this.dirty) {
        this.dirty = false;

        if (await this.wouldWipe()) {
          this.log.error(
            `Refusing to write ${this.file}: this run has nothing in it and the file does. ` +
              'Nothing has been lost. Restart Homebridge to read it again, and if it keeps ' +
              'happening say so, because something is reading the wrong file.',
          );
          this.blocked = true;
          continue;
        }

        const snapshot = JSON.stringify(this.state, null, 2);
        try {
          await mkdir(dirname(this.file), { recursive: true });
          const temporary = `${this.file}.tmp`;
          await writeFile(temporary, snapshot, 'utf8');
          await rename(temporary, this.file);
          await this.backup();
        } catch (error) {
          // Loud, because everything the user configured is in here and the
          // plugin carries on looking perfectly healthy without it.
          this.log.error(
            `Could not write ${this.file}, changes will be lost on restart: ${describe(error)}`,
          );
        }
      }
    })();

    try {
      await this.writing;
    } finally {
      this.writing = undefined;
    }
  }
}

export function storeFile(storagePath: string, directory: string): string {
  return join(storagePath, directory, 'state.json');
}

function migrate(parsed: unknown): PersistedState {
  if (typeof parsed !== 'object' || parsed === null) {
    return emptyState();
  }
  const state = parsed as Partial<PersistedState>;
  return {
    version: STORE_VERSION,
    exposures: state.exposures ?? {},
    rules: state.rules ?? [],
    sessionSecret: state.sessionSecret,
  };
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
