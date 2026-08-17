import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Logger } from './logger.js';

/** Bumped when the shape changes in a way that needs migrating. */
export const STORE_VERSION = 1;

/** HomeKit service a binary on/off property is published as. */
export type TileType = 'Switch' | 'Outlet' | 'Lightbulb' | 'Fan';

export const TILE_TYPES: TileType[] = ['Switch', 'Outlet', 'Lightbulb', 'Fan'];

/** Endpoint key used for properties that belong to the device as a whole. */
export const DEVICE_ENDPOINT = '';

/** What the user ticked for one device. */
export interface DeviceExposure {
  /** Property keys published to HomeKit. Everything else stays rules only. */
  properties: string[];
  /** Tile to use for a binary on/off property, keyed by endpoint. */
  tileTypes?: Record<string, TileType>;
  /** Publish each endpoint as its own accessory rather than one with several services. */
  splitEndpoints?: boolean;
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

/** Placeholder until the rules engine lands in v0.5.0. */
export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
}

export interface PersistedState {
  version: number;
  /** Keyed `sourceId:deviceId`. */
  exposures: Record<string, DeviceExposure>;
  rules: Rule[];
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
export class Store {
  private state: PersistedState = emptyState();
  private writing?: Promise<void>;
  private dirty = false;

  constructor(
    private readonly file: string,
    private readonly log: Logger,
  ) {}

  async load(): Promise<void> {
    try {
      const contents = await readFile(this.file, 'utf8');
      const parsed: unknown = JSON.parse(contents);
      this.state = migrate(parsed);
      this.log.debug(`Loaded state from ${this.file}`);
    } catch (error) {
      if (isNotFound(error)) {
        this.log.info(`No saved state yet, starting fresh (${this.file})`);
        this.state = emptyState();
        return;
      }
      // Refuse to silently start empty, that would drop the user's setup and
      // then overwrite the file they could have recovered it from.
      throw new Error(`Could not read ${this.file}: ${describe(error)}`);
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

  /** Writes via a temporary file so a crash mid write cannot truncate state. */
  async save(): Promise<void> {
    this.dirty = true;
    if (this.writing) {
      return this.writing;
    }

    this.writing = (async () => {
      while (this.dirty) {
        this.dirty = false;
        const snapshot = JSON.stringify(this.state, null, 2);
        try {
          await mkdir(dirname(this.file), { recursive: true });
          const temporary = `${this.file}.tmp`;
          await writeFile(temporary, snapshot, 'utf8');
          await rename(temporary, this.file);
        } catch (error) {
          this.log.error(`Could not write ${this.file}: ${describe(error)}`);
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
