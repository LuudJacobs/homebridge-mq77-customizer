import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Catalog } from '../catalog.js';
import type { WebConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { StateUpdate } from '../model/types.js';
import { isPublishable, roleFor } from '../homekit/roles.js';
import { DEVICE_ENDPOINT, TILE_TYPES, type DeviceExposure, type Store, type TileType } from '../store.js';
import { equals, readCookie, Sessions } from './auth.js';

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/** Slows down password guessing without needing any state. */
const FAILED_LOGIN_DELAY_MS = 500;

export interface WebServerDeps {
  config: WebConfig;
  catalog: Catalog;
  store: Store;
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
    this.deps.store.setExposure(`${sourceId}:${deviceId}`, exposure);
    this.deps.onExposureChanged();

    return send(response, 200, { ok: true, exposure });
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
      const lastSeen: Record<string, number> = {};
      for (const property of device.properties) {
        const at = this.deps.catalog.getLastSeen(device.sourceId, device.deviceId, property.key);
        if (at !== undefined) {
          lastSeen[property.key] = at;
        }
      }

      return {
        sourceId: device.sourceId,
        deviceId: device.deviceId,
        name: device.name,
        manufacturer: device.manufacturer,
        model: device.model,
        description: device.description,
        rulesOnly: device.rulesOnly,
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
          readable: property.access.readable,
          writable: property.access.writable,
          publishable: isPublishable(property),
          role: roleFor(property),
        })),
        exposure: this.deps.store.getExposure(key) ?? { properties: [] },
        state: this.deps.catalog.getState(device.sourceId, device.deviceId) ?? {},
        lastSeen,
      };
    });

    return { devices, tileTypes: TILE_TYPES };
  }

  private async serveStatic(path: string, response: ServerResponse): Promise<void> {
    const relative = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
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

  const names: Record<string, string> = {};
  for (const [endpoint, name] of Object.entries(input.names ?? {})) {
    if (typeof name === 'string' && name.trim().length > 0) {
      names[endpoint] = name.trim().slice(0, 64);
    }
  }

  return {
    properties,
    tileTypes,
    splitEndpoints: input.splitEndpoints === true,
    names,
  };
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
