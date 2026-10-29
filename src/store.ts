import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Logger } from './logger.js';
import type { AnyRule } from './rules/types.js';
import { STATES_SOURCE } from './states.js';

/** Bumped when the shape changes in a way that needs migrating. */
export const STORE_VERSION = 1;

export type { AnyRule, MirrorRule, Rule } from './rules/types.js';

/** HomeKit service a binary on/off property is published as. */
export type TileType = 'Switch' | 'Outlet' | 'Lightbulb' | 'Fan';

export const TILE_TYPES: TileType[] = ['Switch', 'Outlet', 'Lightbulb', 'Fan'];

/** HomeKit sensor an `occupancy` reading can be published as. */
export type SensorType = 'Motion' | 'Occupancy';

export const SENSOR_TYPES: SensorType[] = ['Motion', 'Occupancy'];

/** Endpoint key used for properties that belong to the device as a whole. */
export const DEVICE_ENDPOINT = '';

/** What the user ticked for one device. */
/** The kinds a device can be marked as, for grouping it in the interface. */
export const DEVICE_TYPES = [
  'light',
  // What `sensor` used to mean, said properly: the drawing was always a
  // thermometer. Nothing already marked is rewritten, so a device tagged
  // before this reads as the new `sensor` until it is tagged again.
  'thermometer',
  'sensor',
  // For smoke and heat alarms, sirens and the like.
  'alarm',
  // For a door or window sensor: the two halves and the gap between them.
  'contact',
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
  /**
   * What an `occupancy` reading becomes in HomeKit, keyed by property. Absent
   * means a Motion sensor, which is what a PIR is; an mmWave sensor that also
   * says `occupancy` is switched to an Occupancy sensor by hand.
   */
  sensorTypes?: Record<string, SensorType>;
  /**
   * Whether a low battery is sent to a phone. Absent means yes: only turning
   * it off is written down.
   */
  batteryWarning?: boolean;
}


/** What a state holds: a truth, or a whole number. */
export type StateType = 'boolean' | 'number';

export const STATE_TYPES: StateType[] = ['boolean', 'number'];

/**
 * A value the plugin keeps itself, for rules to set and read: a state.
 *
 * Away, guests, movie night: what the house is doing rather than what any
 * one device is, so it is in no room. Called a state toggle when it could
 * only be true or false, which is what one stored then still is.
 */
export interface StateToggle {
  id: string;
  name: string;
  type: StateType;
  value: boolean | number;
}

/** The rooms a house starts with, before anybody has said which it has. */
export const DEFAULT_ROOMS = ['Living room', 'Kitchen', 'Bedroom', 'Bathroom'];

/** Rooms by name, A to Z, whatever case they were typed in. */
export function sortRooms(rooms: string[]): string[] {
  return [...rooms].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/**
 * A way through the house, as the sensors along it notice somebody: the
 * bedroom to the living room past four of them.
 */
export interface Route {
  id: string;
  name: string;
  /** In the order somebody walking it passes them. */
  sensors: { sourceId: string; deviceId: string }[];
  /** How long from the first sensor to the last, at most, for it to be walked. */
  walkMs: number;
  /** Whether it is walked back the other way as well. */
  bothWays: boolean;
}

export interface PersistedState {
  version: number;
  /** Keyed `sourceId:deviceId`. */
  exposures: Record<string, DeviceExposure>;
  rules: AnyRule[];
  states: StateToggle[];
  /** The rooms a device can be put in, A to Z. */
  rooms: string[];
  routes: Route[];
  /** Signs web session cookies. Generated on first run so logins survive restarts. */
  sessionSecret?: string;
}

function emptyState(): PersistedState {
  return {
    version: STORE_VERSION,
    exposures: {},
    rules: [],
    states: [],
    rooms: sortRooms(DEFAULT_ROOMS),
    routes: [],
  };
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

      this.startedFull = hasAnything(this.state);

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

  /**
   * Takes a copy now, whether or not one was due.
   *
   * Written out first: on a fresh install there is nothing on disk yet, and
   * there would be nothing to copy.
   */
  async backupNow(): Promise<number | undefined> {
    await this.save();
    await this.backup(true);
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
    this.startedFull = hasAnything(this.state);
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
    if (this.startedFull || hasAnything(this.state)) {
      return false;
    }

    try {
      return hasAnything(migrate(JSON.parse(await readFile(this.file, 'utf8')) as unknown));
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
  const exposures = state.exposures ?? {};

  // Rooms became a list of their own. Settings from before it start from the
  // usual few, and every device's room is emptied to be set again from them,
  // rather than carrying over whatever was typed into a free text box.
  let rooms: string[];
  if (Array.isArray(state.rooms)) {
    rooms = sortRooms(
      [...new Set(state.rooms.filter((room): room is string => typeof room === 'string'))]
        .map((room) => room.trim())
        .filter(Boolean),
    );
  } else {
    rooms = sortRooms(DEFAULT_ROOMS);
    for (const exposure of Object.values(exposures)) {
      delete exposure.room;
    }
  }

  // States are in no room, so nothing about one is kept beside the devices.
  for (const key of Object.keys(exposures)) {
    if (key.startsWith(`${STATES_SOURCE}:`)) {
      delete exposures[key];
    }
  }
  const states = (Array.isArray(state.states) ? state.states : []).flatMap(readToggle);
  const truths = new Set(states.filter((one) => one.type === 'boolean').map((one) => one.id));

  return {
    version: STORE_VERSION,
    exposures,
    rooms,
    // Timers were folded into automations, which can wait. One stored by an
    // older version is dropped rather than carried: nothing runs it, nothing
    // draws it, and leaving it would only be a rule that never fires.
    rules: (state.rules ?? [])
      .filter((rule) => (rule as { kind?: string } | undefined)?.kind !== 'timer')
      .map(withoutRoutes)
      .map((rule) => askingTruthsPlainly(rule, truths)),
    states,
    // One from a test build has a gap between sensors rather than a time for
    // the whole walk, and is not one of these.
    routes: (Array.isArray(state.routes) ? state.routes : []).filter(isRoute),
    sessionSecret: state.sessionSecret,
  };
}

/**
 * A rule without the routes a test build let its conditions ask about.
 * Routes set a rule off now, and are never asked about.
 *
 * The question goes, and a rule that asked one is switched off: the route
 * was holding it back, and running it without that is for somebody to decide.
 */
function withoutRoutes(rule: AnyRule): AnyRule {
  const branches = (rule as { branches?: { when?: unknown }[] }).branches;
  if (!Array.isArray(branches)) {
    return rule;
  }
  let asked = false;
  const prune = (node: unknown): unknown => {
    const { kind } = (node ?? {}) as { kind?: string };
    if (kind === 'route') {
      asked = true;
      return undefined;
    }
    if (kind === 'not') {
      const inner = prune((node as { node: unknown }).node);
      return inner === undefined ? undefined : { kind, node: inner };
    }
    if (kind === 'all' || kind === 'any') {
      const nodes = (node as { nodes: unknown[] }).nodes.map(prune).filter(Boolean);
      return nodes.length > 0 ? { kind, nodes } : undefined;
    }
    return node;
  };
  const pruned = branches.map((branch) => {
    if (branch.when === undefined) {
      return branch;
    }
    const { when, ...rest } = branch;
    const kept = prune(when);
    return kept === undefined ? rest : { ...rest, when: kept };
  });
  return asked ? ({ ...rule, enabled: false, branches: pruned } as AnyRule) : rule;
}

/**
 * One stored state, or nothing for one that is not; one from before types is
 * a truth. A Text state is nothing now: rules that used one say what is
 * missing, as they do for a deleted device.
 */
function readToggle(value: unknown): StateToggle[] {
  const toggle = value as { id?: unknown; name?: unknown; type?: unknown; value?: unknown };
  if (typeof toggle?.id !== 'string' || typeof toggle.name !== 'string') {
    return [];
  }
  const type = toggle.type ?? 'boolean';
  if (type === 'boolean' && typeof toggle.value === 'boolean') {
    return [{ id: toggle.id, name: toggle.name, type, value: toggle.value }];
  }
  if (type === 'number' && typeof toggle.value === 'number' && Number.isInteger(toggle.value)) {
    return [{ id: toggle.id, name: toggle.name, type, value: toggle.value }];
  }
  return [];
}

/**
 * A rule asking a truth only what a truth is offered: becomes or changes to
 * set it off, is to be asked. What it asked before is said that way where it
 * means the same, which a state that only reports a change always does: `is
 * true` sets a rule off when it becomes true, and `is not true` is `is false`.
 * A condition asking whether one changes, or an action matching the trigger,
 * has no such twin and is left as it is.
 */
function askingTruthsPlainly(rule: AnyRule, truths: Set<string>): AnyRule {
  const isTruth = (ref: unknown) => {
    const { sourceId, deviceId } = (ref ?? {}) as { sourceId?: unknown; deviceId?: unknown };
    return sourceId === STATES_SOURCE && typeof deviceId === 'string' && truths.has(deviceId);
  };
  const other = (value: unknown) =>
    typeof value === 'boolean' ? !value : String(String(value).toLowerCase() !== 'true');
  const said = <T extends { match?: { kind?: string; value?: unknown } }>(
    ref: T,
    as: 'trigger' | 'condition',
  ): T => {
    const match = ref.match;
    if (!isTruth(ref) || !match) {
      return ref;
    }
    if (as === 'trigger' && match.kind === 'equals') {
      return { ...ref, match: { kind: 'changedTo', value: match.value } };
    }
    if (as === 'trigger' && match.kind === 'notEquals') {
      return { ...ref, match: { kind: 'changedTo', value: other(match.value) } };
    }
    if (as === 'condition' && match.kind === 'notEquals') {
      return { ...ref, match: { kind: 'equals', value: other(match.value) } };
    }
    if (as === 'condition' && match.kind === 'changedTo') {
      return { ...ref, match: { kind: 'equals', value: match.value } };
    }
    return ref;
  };
  const asked = (node: unknown): unknown => {
    const shaped = node as { kind?: string; node?: unknown; nodes?: unknown[] };
    if (shaped?.kind === 'not') {
      return { ...shaped, node: asked(shaped.node) };
    }
    if (shaped?.kind === 'all' || shaped?.kind === 'any') {
      return { ...shaped, nodes: (shaped.nodes ?? []).map(asked) };
    }
    return shaped?.kind === 'test' ? said(shaped as never, 'condition') : node;
  };

  const raw = rule as {
    trigger?: unknown;
    triggers?: unknown[];
    conditions?: unknown[];
    branches?: { when?: unknown }[];
  };
  if (!raw.trigger && !raw.triggers && !raw.branches && !raw.conditions) {
    return rule;
  }
  return {
    ...rule,
    ...(raw.trigger ? { trigger: said(raw.trigger as never, 'trigger') } : {}),
    ...(raw.triggers ? { triggers: raw.triggers.map((one) => said(one as never, 'trigger')) } : {}),
    ...(raw.conditions
      ? { conditions: raw.conditions.map((one) => said(one as never, 'condition')) }
      : {}),
    ...(raw.branches
      ? {
          branches: raw.branches.map((branch) =>
            branch.when === undefined ? branch : { ...branch, when: asked(branch.when) },
          ),
        }
      : {}),
  } as AnyRule;
}

function isRoute(value: unknown): value is Route {
  const route = value as Partial<Route> | undefined;
  return (
    typeof route?.id === 'string' &&
    typeof route.name === 'string' &&
    Array.isArray(route.sensors) &&
    route.sensors.every(
      (sensor) => typeof sensor?.sourceId === 'string' && typeof sensor.deviceId === 'string',
    ) &&
    typeof route.walkMs === 'number' &&
    typeof route.bothWays === 'boolean'
  );
}

/** Whether there is anything in it somebody would miss. */
function hasAnything(state: PersistedState): boolean {
  return (
    Object.keys(state.exposures).length > 0 ||
    state.rules.length > 0 ||
    state.states.length > 0 ||
    state.routes.length > 0
  );
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
