import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Catalog } from '../catalog.js';
import type { WebConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { NormalisedProperty, StateUpdate } from '../model/types.js';
import { buttonsFrom, isPublishable, roleFor } from '../homekit/roles.js';
import {
  DEVICE_ENDPOINT,
  DEVICE_TYPES,
  STATE_TYPES,
  TILE_TYPES,
  type DeviceExposure,
  type DeviceType,
  type SensorType,
  type StateType,
  sortRooms,
  type Store,
  type TileType,
} from '../store.js';
import { randomUUID } from 'node:crypto';

import type { RulesEngine } from '../rules/engine.js';
import { parseRule } from '../rules/validate.js';
import { STATES_SOURCE, TEXT_PATTERN, type StateToggles } from '../states.js';
import { equals, readCookie, Sessions } from './auth.js';

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const BUILD_INFO = fileURLToPath(new URL('../build-info.json', import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/** Slows down password guessing without needing any state. */
const FAILED_LOGIN_DELAY_MS = 500;

export interface WebServerDeps {
  config: WebConfig;
  /**
   * Whether a location is set, which is all the interface needs to know.
   *
   * Not the coordinates themselves: the editor only asks so it can decide
   * whether to offer the sun times, and where the house is has no business
   * being served to a browser.
   */
  hasLocation?: boolean;
  /** Whether a topic is set, which is what offers Send notification. */
  canNotify?: boolean;
  catalog: Catalog;
  store: Store;
  rules: RulesEngine;
  /** The state toggles, which are made, named and flipped from here. */
  states?: StateToggles;
  log: Logger;
  /** Called after an exposure changes so HomeKit can be reconciled. */
  onExposureChanged: () => void;
}

export class WebServer {
  private server?: Server;
  private readonly sessions: Sessions;
  private readonly listeners = new Set<ServerResponse>();

  constructor(private readonly deps: WebServerDeps) {
    this.sessions = new Sessions(deps.store.sessionSecret());
  }

  async start(): Promise<void> {
    if (!this.deps.config.password) {
      this.deps.log.error(
        'No web password set, refusing to start the web interface. ' +
          'Add "web": { "password": "..." } to the platform config. ' +
          'It can switch your devices, so it should not be open to the network.',
      );
      return;
    }

    const server = createServer((request, response) => {
      this.handle(request, response).catch((error: unknown) => {
        this.deps.log.error(`Request for ${request.url} failed: ${describe(error)}`);
        if (!response.headersSent) {
          send(response, 500, { error: 'Internal error' });
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.deps.config.port, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    this.server = server;
    // Not "localhost": it is browsed from another machine, and saying
    // localhost sends people to the wrong host when it does not respond.
    this.deps.log.info(`Web interface listening on port ${this.port}`);

    this.deps.catalog.on('state', (update) => this.broadcastState(update));
    this.deps.catalog.on('devices', () => this.broadcast({ type: 'devices' }));
    this.deps.rules.on('log', (entry) => this.broadcast({ type: 'log', entry }));
  }

  /** The port actually bound, which differs from the configured one when it is 0. */
  get port(): number {
    const address = this.server?.address();
    return typeof address === 'object' && address !== null ? address.port : this.deps.config.port;
  }

  async stop(): Promise<void> {
    for (const listener of this.listeners) {
      listener.end();
    }
    this.listeners.clear();

    const server = this.server;
    this.server = undefined;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (path === '/api/login' && request.method === 'POST') {
      return this.login(request, response);
    }

    if (path === '/api/logout' && request.method === 'POST') {
      response.setHeader('Set-Cookie', this.sessions.clearHeader());
      return send(response, 200, { ok: true });
    }

    if (path.startsWith('/api/')) {
      if (!this.authorised(request)) {
        return send(response, 401, { error: 'Not signed in' });
      }
      if (path === '/api/state' && request.method === 'GET') {
        return send(response, 200, this.snapshot());
      }
      if (path === '/api/exposure' && request.method === 'PUT') {
        return this.saveExposure(request, response);
      }
      if (path === '/api/rules' && request.method === 'GET') {
        return send(response, 200, { rules: this.deps.store.data.rules });
      }
      if (path === '/api/rules' && request.method === 'PUT') {
        return this.saveRule(request, response);
      }
      if (path.endsWith('/run') && request.method === 'POST') {
        const id = decodeURIComponent(path.slice('/api/rules/'.length, -'/run'.length));
        if (!this.deps.rules.runNow(id)) {
          return send(response, 404, { error: 'No rule of that kind to run' });
        }
        return send(response, 200, { ok: true });
      }
      if (path.startsWith('/api/rules/') && request.method === 'DELETE') {
        return this.deleteRule(decodeURIComponent(path.slice('/api/rules/'.length)), response);
      }
      if (path === '/api/rooms' && ['POST', 'PUT', 'DELETE'].includes(request.method ?? '')) {
        return this.changeRooms(request, response);
      }
      if (path === '/api/devices' && request.method === 'DELETE') {
        return this.forgetDevice(request, response);
      }
      if (path === '/api/states' && request.method === 'POST') {
        return this.createToggle(request, response);
      }
      if (path.startsWith('/api/states/') && request.method === 'PUT') {
        const id = decodeURIComponent(path.slice('/api/states/'.length));
        return this.changeToggle(id, request, response);
      }
      if (path.startsWith('/api/states/') && request.method === 'DELETE') {
        return this.deleteToggle(decodeURIComponent(path.slice('/api/states/'.length)), response);
      }
      if (path === '/api/settings' && request.method === 'GET') {
        return this.exportSettings(response);
      }
      if (path === '/api/settings' && request.method === 'PUT') {
        return this.importSettings(request, response);
      }
      if (path === '/api/settings/backup' && request.method === 'POST') {
        return send(response, 200, { backupAt: await this.deps.store.backupNow() });
      }
      if (path === '/api/log' && request.method === 'DELETE') {
        this.deps.rules.clearLog();
        return send(response, 200, { ok: true });
      }
      if (path === '/api/log' && request.method === 'GET') {
        return send(response, 200, { entries: this.deps.rules.getLog() });
      }
      if (path === '/api/map' && request.method === 'POST') {
        return this.networkMap(response);
      }
      if (path === '/api/events' && request.method === 'GET') {
        return this.subscribe(response);
      }
      return send(response, 404, { error: 'Unknown endpoint' });
    }

    return this.serveStatic(path, response);
  }

  private authorised(request: IncomingMessage): boolean {
    return this.sessions.verify(readCookie(request.headers.cookie));
  }

  private async login(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJson(request);
    const password = typeof body?.password === 'string' ? body.password : '';

    if (!equals(password, this.deps.config.password ?? '')) {
      await delay(FAILED_LOGIN_DELAY_MS);
      return send(response, 401, { error: 'Wrong password' });
    }

    response.setHeader('Set-Cookie', this.sessions.cookieHeader(this.sessions.issue()));
    return send(response, 200, { ok: true });
  }

  private async saveExposure(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJson(request);
    const sourceId = typeof body?.sourceId === 'string' ? body.sourceId : undefined;
    const deviceId = typeof body?.deviceId === 'string' ? body.deviceId : undefined;

    if (!sourceId || !deviceId) {
      return send(response, 400, { error: 'sourceId and deviceId are required' });
    }

    const device = this.deps.catalog.getDevice(sourceId, deviceId);
    if (!device) {
      return send(response, 404, { error: 'No such device' });
    }

    const exposure = sanitiseExposure(body?.exposure, device.properties.map((p) => p.key));
    // Only a room from the list, written the way the list has it.
    const room = this.deps.store.data.rooms.find(
      (known) => known.toLowerCase() === exposure.room?.toLowerCase(),
    );
    if (room) {
      exposure.room = room;
    } else {
      delete exposure.room;
    }
    if (sourceId === STATES_SOURCE) {
      // A toggle has a room and nothing else: no HomeKit, and a kind that is
      // always its own.
      const room = exposure.room;
      this.deps.store.setExposure(`${sourceId}:${deviceId}`, {
        properties: [],
        ...(room ? { room } : {}),
      });
      return send(response, 200, { ok: true, exposure: toggleExposure(room) });
    }
    this.deps.store.setExposure(`${sourceId}:${deviceId}`, exposure);
    this.deps.onExposureChanged();

    return send(response, 200, { ok: true, exposure });
  }

  private async saveRule(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJson(request);
    const id = typeof body?.id === 'string' && body.id ? body.id : randomUUID();
    const parsed = parseRule(body, id);

    if ('error' in parsed) {
      return send(response, 400, { error: parsed.error });
    }

    this.deps.store.update((state) => {
      const existing = state.rules.findIndex((rule) => rule.id === id);
      if (existing >= 0) {
        state.rules[existing] = parsed.rule;
      } else {
        state.rules.push(parsed.rule);
      }
    });

    this.broadcast({ type: 'rules' });
    return send(response, 200, { rule: parsed.rule });
  }

  private deleteRule(id: string, response: ServerResponse): void {
    let removed = false;
    this.deps.store.update((state) => {
      const index = state.rules.findIndex((rule) => rule.id === id);
      if (index >= 0) {
        state.rules.splice(index, 1);
        removed = true;
      }
    });

    if (!removed) {
      return send(response, 404, { error: 'No such rule' });
    }
    this.broadcast({ type: 'rules' });
    return send(response, 200, { ok: true });
  }

  /**
   * Adds, renames or removes a room.
   *
   * Everything in a room goes with it: renamed, it is in the room of the new
   * name; removed, it is in no room at all.
   */
  private async changeRooms(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJson(request);
    const name = (raw: unknown) => (typeof raw === 'string' ? raw.trim().slice(0, 64) : '');
    const rooms = this.deps.store.data.rooms;
    const find = (wanted: string) =>
      rooms.find((room) => room.toLowerCase() === wanted.toLowerCase());

    if (request.method === 'POST') {
      const added = name(body?.name);
      if (!added) {
        return send(response, 400, { error: 'A room needs a name' });
      }
      if (find(added)) {
        return send(response, 400, { error: `There is a room called ${find(added)} already` });
      }
      this.deps.store.update((state) => {
        state.rooms = sortRooms([...state.rooms, added]);
      });
    } else {
      const old = find(name(body?.name));
      if (!old) {
        return send(response, 404, { error: 'No such room' });
      }
      const renamed = request.method === 'PUT' ? name(body?.to) : undefined;
      if (request.method === 'PUT' && !renamed) {
        return send(response, 400, { error: 'A room needs a name' });
      }
      const taken = renamed ? find(renamed) : undefined;
      if (taken && taken !== old) {
        return send(response, 400, { error: `There is a room called ${taken} already` });
      }
      this.deps.store.update((state) => {
        const others = state.rooms.filter((room) => room !== old);
        state.rooms = sortRooms(renamed ? [...others, renamed] : others);
        for (const exposure of Object.values(state.exposures)) {
          if (exposure.room !== old) {
            continue;
          }
          if (renamed) {
            exposure.room = renamed;
          } else {
            delete exposure.room;
          }
        }
      });
    }

    this.broadcast({ type: 'devices' });
    return send(response, 200, { rooms: this.deps.store.data.rooms });
  }

  /**
   * Forgets what was set for a device: its name, room, kind and tiles.
   *
   * Nothing stops it coming back. A source that lists what it has, as
   * Zigbee2MQTT does, shows it again at once with nothing set; one that lists
   * what it hears shows it again when it next says something.
   */
  private async forgetDevice(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJson(request);
    const sourceId = typeof body?.sourceId === 'string' ? body.sourceId : undefined;
    const deviceId = typeof body?.deviceId === 'string' ? body.deviceId : undefined;
    if (!sourceId || !deviceId) {
      return send(response, 400, { error: 'sourceId and deviceId are required' });
    }
    if (sourceId === STATES_SOURCE) {
      return this.deleteToggle(deviceId, response);
    }

    this.deps.store.update((state) => {
      delete state.exposures[`${sourceId}:${deviceId}`];
    });
    this.deps.catalog.forget(sourceId, deviceId);
    this.deps.onExposureChanged();
    // The list changed even where the source still has the device: what was
    // set for it has gone.
    this.broadcast({ type: 'devices' });
    return send(response, 200, { ok: true });
  }

  private async createToggle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.deps.states) {
      return send(response, 501, { error: 'No internal states here' });
    }
    const body = await readJson(request);
    const name = toggleName(body?.name) ?? 'New internal state';
    const type = STATE_TYPES.includes(body?.type as StateType) ? (body?.type as StateType) : 'boolean';
    const toggle = this.deps.states.create(name, type);
    return send(response, 200, { id: toggle.id });
  }

  private async changeToggle(
    id: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const toggles = this.deps.states;
    const current = toggles?.find(id);
    if (!toggles || !current) {
      return send(response, 404, { error: 'No such internal state' });
    }
    const body = await readJson(request);

    // Everything is checked before anything is changed, so a refusal leaves
    // the state as it was rather than renamed and not set.
    const name = body?.name === undefined ? undefined : toggleName(body.name);
    if (body?.name !== undefined && !name) {
      return send(response, 400, { error: 'An internal state needs a name' });
    }
    if (body?.type !== undefined && !STATE_TYPES.includes(body.type as StateType)) {
      return send(response, 400, { error: 'An internal state is a boolean, text or a number' });
    }
    const type = (body?.type as StateType | undefined) ?? current.type;
    const value = body?.value;
    if (value !== undefined) {
      const problem = valueProblem(type, value);
      if (problem) {
        return send(response, 400, { error: problem });
      }
    }

    if (name) {
      toggles.rename(id, name);
    }
    toggles.retype(id, type);
    if (value !== undefined) {
      toggles.set(id, typeof value === 'string' ? value.trim() : value, true);
    }
    return send(response, 200, { ok: true });
  }

  private deleteToggle(id: string, response: ServerResponse): void {
    if (!this.deps.states?.remove(id)) {
      return send(response, 404, { error: 'No such internal state' });
    }
    return send(response, 200, { ok: true });
  }

  private subscribe(response: ServerResponse): void {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    response.write(': connected\n\n');
    this.listeners.add(response);

    // Proxies and phones drop idle connections, so keep a trickle going.
    const heartbeat = setInterval(() => response.write(': ping\n\n'), 30000);
    response.on('close', () => {
      clearInterval(heartbeat);
      this.listeners.delete(response);
    });
  }

  private broadcastState(update: StateUpdate): void {
    this.broadcast({
      type: 'state',
      sourceId: update.sourceId,
      deviceId: update.deviceId,
      changes: update.changes,
      at: update.at,
      ...(update.reportedLastSeen === undefined
        ? {}
        : { reportedLastSeen: update.reportedLastSeen }),
    });
  }

  private broadcast(payload: unknown): void {
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    for (const listener of this.listeners) {
      listener.write(line);
    }
  }

  private snapshot(): unknown {
    const devices = this.deps.catalog.getDevices().map((device) => {
      const key = `${device.sourceId}:${device.deviceId}`;
      const endpoints = [
        ...new Set(device.properties.map((property) => property.endpoint ?? DEVICE_ENDPOINT)),
      ];
      return {
        sourceId: device.sourceId,
        deviceId: device.deviceId,
        name: device.name,
        topic: device.topic,
        manufacturer: device.manufacturer,
        model: device.model,
        description: device.description,
        rulesOnly: device.rulesOnly,
        renameable: device.renameable,
        endpoints,
        properties: device.properties.map((property) => ({
          key: property.key,
          label: property.label,
          semantic: property.semantic,
          type: property.type,
          category: property.category,
          endpoint: property.endpoint ?? DEVICE_ENDPOINT,
          group: property.group,
          unit: property.unit,
          min: property.min,
          max: property.max,
          step: property.step,
          values: property.values,
          // The interface offers these as choices, so it needs the words this
          // device actually uses rather than a guess at ON and OFF.
          onValue: property.onValue,
          offValue: property.offValue,
          toggleValue: property.toggleValue,
          readable: property.access.readable,
          writable: property.access.writable,
          publishable: isPublishable(property),
          role: roleFor(property),
          buttons: describeButtons(property),
        })),
        // Two things about the device rather than about any one function of
        // it, both worth seeing when something is not reporting as expected.
        retained: device.retained,
        reportedLastSeen: this.deps.catalog.getReportedLastSeen(device.sourceId, device.deviceId),
        exposure:
          device.sourceId === STATES_SOURCE
            ? toggleExposure(this.deps.store.getExposure(key)?.room)
            : (this.deps.store.getExposure(key) ?? { properties: [] }),
        state: this.deps.catalog.getState(device.sourceId, device.deviceId) ?? {},
      };
    });

    return {
      devices,
      rooms: this.deps.store.data.rooms,
      tileTypes: TILE_TYPES,
      links: { zigbee2mqtt: this.deps.config.zigbee2mqttUrl },
      hasLocation: this.deps.hasLocation === true,
      canNotify: this.deps.canNotify === true,
      build: buildLabel(),
      backupAt: this.deps.store.lastBackup(),
      refusedToWrite: this.deps.store.refusedToWrite,
    };
  }

  /**
   * Runs a network scan and answers with what it found.
   *
   * A scan takes minutes, so this request is held open for the length of one
   * rather than answered now and collected later. It is only ever started
   * because somebody pressed the button.
   */
  private async networkMap(response: ServerResponse): Promise<void> {
    try {
      const map = await this.deps.catalog.getNetworkMap();
      if (!map) {
        return send(response, 501, {
          error: 'No source here can describe a network. That needs Zigbee2MQTT.',
        });
      }
      return send(response, 200, map);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      this.deps.log.error(`Network map failed: ${why}`);
      return send(response, 502, { error: why });
    }
  }

  /**
   * Hands over everything worth keeping, as a file to save somewhere else.
   *
   * Without the session secret: it signs the cookie that keeps you signed in,
   * it regenerates on its own, and a settings file is a thing people mail to
   * themselves.
   */
  private exportSettings(response: ServerResponse): void {
    const { sessionSecret: _secret, ...rest } = this.deps.store.data;
    const stamp = new Date().toISOString().slice(0, 10);
    const body = JSON.stringify(rest, null, 2);

    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="mq77-settings-${stamp}.json"`,
      'Content-Length': Buffer.byteLength(body),
    });
    response.end(body);
  }

  /**
   * Puts a settings file back, over whatever is there.
   *
   * A copy of what is being replaced is taken first, so uploading the wrong
   * file is not the end of it either.
   */
  private async importSettings(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await readJson(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return send(response, 400, { error: 'That is not a settings file' });
    }

    const incoming = body as { exposures?: unknown; rules?: unknown };
    if (typeof incoming.exposures !== 'object' || !Array.isArray(incoming.rules)) {
      return send(response, 400, {
        error: 'That file has no devices or rules in it, so it is not one of ours',
      });
    }

    await this.deps.store.replaceAll(body);
    this.deps.states?.reload();
    this.deps.onExposureChanged();

    const counts = {
      devices: Object.keys(this.deps.store.data.exposures).length,
      rules: this.deps.store.data.rules.length,
    };
    this.deps.log.info(
      `Settings replaced from an uploaded file: ${counts.devices} device(s), ${counts.rules} rule(s)`,
    );
    return send(response, 200, counts);
  }

  private async serveStatic(path: string, response: ServerResponse): Promise<void> {
    // Every tab has an address of its own, /rules or /home/rooms, and the page
    // works out from it which to show; one it does not know shows Devices.
    // Anything with an extension is a file, and missing if it is not there.
    const page = extname(path) === '';
    const relative = page ? 'index.html' : path.replace(/^\/+/, '');
    // normalize collapses any `..` before it can escape the public directory.
    const file = join(PUBLIC_DIR, normalize(relative));
    if (!file.startsWith(PUBLIC_DIR)) {
      return send(response, 403, { error: 'Forbidden' });
    }

    try {
      const contents = await readFile(file);
      response.writeHead(200, {
        'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      response.end(contents);
    } catch {
      send(response, 404, { error: 'Not found' });
    }
  }
}

/**
 * The buttons and gestures inferred from an action property, so the interface
 * can offer them individually rather than all or nothing.
 */
function describeButtons(property: NormalisedProperty): unknown {
  if (roleFor(property) !== 'action') {
    return undefined;
  }
  return [...buttonsFrom(property.values ?? [])].map(([name, actions]) => ({
    name,
    gestures: [...new Set(actions.flatMap((action) => (action.event === undefined ? [] : [action.event])))].sort(),
    /** Values HomeKit has no gesture for, listed so the interface can say so. */
    unsupported: actions.filter((action) => action.event === undefined).map((action) => action.value),
    /**
     * Which press each value arrives as, so the interface can say of a single
     * press whether HomeKit hears it. Worked out here rather than there: the
     * accessory is built from this reading of the value and no other.
     */
    events: Object.fromEntries(
      actions.flatMap((action) => (action.event === undefined ? [] : [[action.value, action.event]])),
    ),
  }));
}

/**
 * A toggle's exposure as the interface sees it.
 *
 * Its kind is not stored, since nothing could ever change it: it is said here
 * so the interface groups and draws a toggle like any other kind.
 */
function toggleExposure(room: string | undefined): unknown {
  return { properties: [], ...(room ? { room } : {}), type: 'state' };
}

/** Why a value is not one an internal state of this type can hold, if it is not. */
function valueProblem(type: StateType, value: unknown): string | undefined {
  if (type === 'boolean' && typeof value !== 'boolean') {
    return 'A boolean is true or false';
  }
  if (type === 'text' && (typeof value !== 'string' || !TEXT_PATTERN.test(value.trim()))) {
    return 'Text is up to 12 of a to z, 0 to 9, - and _';
  }
  if (type === 'number' && !Number.isInteger(value)) {
    return 'A number is a whole number';
  }
  return undefined;
}

function toggleName(raw: unknown): string | undefined {
  const name = typeof raw === 'string' ? raw.trim().slice(0, 64) : '';
  return name || undefined;
}

/** Keeps only property keys the device actually has, and known tile types. */
export function sanitiseExposure(raw: unknown, knownKeys: string[]): DeviceExposure {
  const known = new Set(knownKeys);
  const input = (raw ?? {}) as Partial<DeviceExposure>;

  const properties = Array.isArray(input.properties)
    ? [...new Set(input.properties.filter((key): key is string => known.has(key)))]
    : [];

  const tileTypes: Record<string, TileType> = {};
  for (const [endpoint, tile] of Object.entries(input.tileTypes ?? {})) {
    if (TILE_TYPES.includes(tile as TileType)) {
      tileTypes[endpoint] = tile as TileType;
    }
  }

  // Only a choice away from the default is kept, and only for a reading the
  // device has: Motion is what absent means.
  const sensorTypes: Record<string, SensorType> = {};
  for (const [propertyKey, sensor] of Object.entries(input.sensorTypes ?? {})) {
    if (known.has(propertyKey) && sensor === 'Occupancy') {
      sensorTypes[propertyKey] = sensor;
    }
  }

  const label = typeof input.label === 'string' ? input.label.trim().slice(0, 64) : '';
  const room = typeof input.room === 'string' ? input.room.trim().slice(0, 64) : '';
  const type = DEVICE_TYPES.includes(input.type as DeviceType) ? (input.type as DeviceType) : undefined;

  const names: Record<string, string> = {};
  for (const [endpoint, name] of Object.entries(input.names ?? {})) {
    if (typeof name === 'string' && name.trim().length > 0) {
      names[endpoint] = name.trim().slice(0, 64);
    }
  }

  const buttons: Record<string, Record<string, number[]>> = {};
  for (const [propertyKey, perButton] of Object.entries(input.buttons ?? {})) {
    if (!known.has(propertyKey) || typeof perButton !== 'object' || perButton === null) {
      continue;
    }
    const kept: Record<string, number[]> = {};
    for (const [button, events] of Object.entries(perButton)) {
      if (!Array.isArray(events)) {
        continue;
      }
      // An empty list is meaningful: it switches the button off.
      kept[button] = [...new Set(events.filter((event) => HOMEKIT_EVENTS.includes(event)))];
    }
    buttons[propertyKey] = kept;
  }

  return {
    properties,
    tileTypes,
    splitEndpoints: input.splitEndpoints === true,
    // An empty name means "use the source's name", not an empty accessory.
    ...(label ? { label } : {}),
    ...(room ? { room } : {}),
    ...(type ? { type } : {}),
    names,
    buttons,
    ...(Object.keys(sensorTypes).length > 0 ? { sensorTypes } : {}),
    // On unless turned off, so only the off is kept.
    ...(input.batteryWarning === false ? { batteryWarning: false } : {}),
  };
}

/** Single, double and long press. HomeKit has no others. */
const HOMEKIT_EVENTS = [0, 1, 2];

/**
 * What the header says after the title.
 *
 * A released build says its version. Anything else says which branch it came
 * from, so a page open on a laptop cannot be mistaken for the one running the
 * house.
 */
let cachedLabel: string | undefined;
function buildLabel(): string {
  if (cachedLabel === undefined) {
    try {
      const info = JSON.parse(readFileSync(BUILD_INFO, 'utf8')) as {
        branch: string | null;
        version: string;
        released: boolean;
      };
      // An unreleased build says which branch it came from. One that cannot
      // name a branch says its version, which was stamped for that build and
      // carries a tail saying as much.
      cachedLabel = info.released || !info.branch ? info.version : `#${info.branch}`;
    } catch {
      // Built without the labeller, which is not worth failing over.
      cachedLabel = '';
    }
  }
  return cachedLabel;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 256 * 1024) {
      throw new Error('Request body too large');
    }
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
