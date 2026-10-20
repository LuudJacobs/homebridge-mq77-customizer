import type { Catalog } from './catalog.js';
import { roleFor } from './homekit/roles.js';
import { isShut, toBoolean } from './homekit/values.js';
import type { StateUpdate } from './model/types.js';
import type { Route, Store } from './store.js';

/** How long between two sensors a route starts with. */
export const DEFAULT_GAP_MS = 10_000;

type Sensor = Route['sensors'][number];

/** Where somebody is on a route, and which way they are going. */
export interface RoutePosition {
  at: Sensor;
  direction: 'forward' | 'back';
}

/** One route's walker: the sensor passed last, which way, and when. */
interface Walk {
  index: number;
  direction: 'forward' | 'back';
  at: number;
}

const keyOf = (sensor: Sensor) => `${sensor.sourceId}:${sensor.deviceId}`;

/**
 * Follows somebody along the routes, from the sensors on them.
 *
 * On a route from the second sensor in order, one sensor on its own being
 * only somebody in that room. Each sensor after that in the same order moves
 * them along, and longer than the route's gap without one takes them off it,
 * the last sensor included. Nobody is told apart: it is where the latest
 * walk along a route is, which is a guess, and good enough for a rule.
 *
 * Kept while Homebridge runs and no longer: a walk is seconds long.
 */
export class RouteTracker {
  /** When each sensor last noticed somebody, for the start of a route. */
  private readonly heard = new Map<string, number>();
  private readonly walks = new Map<string, Walk>();

  constructor(
    private readonly store: Store,
    private readonly catalog: Catalog,
    private readonly now: () => number = () => Date.now(),
  ) {}

  handleState(update: StateUpdate): void {
    // A value replayed on connect is not somebody walking past.
    if (update.retained || !this.noticed(update)) {
      return;
    }
    const sensor = { sourceId: update.sourceId, deviceId: update.deviceId };
    for (const route of this.store.data.routes) {
      const index = route.sensors.findIndex((candidate) => keyOf(candidate) === keyOf(sensor));
      if (index >= 0) {
        this.step(route, index, update.at);
      }
    }
    this.heard.set(keyOf(sensor), update.at);
  }

  /** Where somebody is on a route now, if anybody is. */
  position(routeId: string): RoutePosition | undefined {
    const route = this.store.data.routes.find((candidate) => candidate.id === routeId);
    const walk = this.walks.get(routeId);
    if (!route || !walk || this.now() - walk.at > route.gapMs) {
      return undefined;
    }
    const at = route.sensors[walk.index];
    return at ? { at, direction: walk.direction } : undefined;
  }

  private step(route: Route, index: number, at: number): void {
    const walk = this.walks.get(route.id);
    if (walk && at - walk.at <= route.gapMs) {
      // Noticed again where they are: still there.
      if (index === walk.index) {
        walk.at = at;
        return;
      }
      const next = walk.direction === 'forward' ? walk.index + 1 : walk.index - 1;
      if (index === next) {
        this.walks.set(route.id, { index, direction: walk.direction, at });
        return;
      }
    }

    // A start: the sensor before this one noticed somebody, in time.
    const recently = (other: Sensor | undefined) =>
      other !== undefined && at - (this.heard.get(keyOf(other)) ?? -Infinity) <= route.gapMs;
    if (recently(route.sensors[index - 1])) {
      this.walks.set(route.id, { index, direction: 'forward', at });
    } else if (route.bothWays && recently(route.sensors[index + 1])) {
      this.walks.set(route.id, { index, direction: 'back', at });
    }
  }

  /** Whether a message says somebody is there: motion, presence, a door opening. */
  private noticed(update: StateUpdate): boolean {
    const device = this.catalog.getDevice(update.sourceId, update.deviceId);
    if (!device) {
      return false;
    }
    return Object.entries(update.changes).some(([key, value]) => {
      const property = device.properties.find((candidate) => candidate.key === key);
      const role = property ? roleFor(property) : undefined;
      if (!property || value === undefined || value === null) {
        return false;
      }
      if (role === 'motion' || role === 'occupancy') {
        return toBoolean(property, value);
      }
      return role === 'contact' && !isShut(value);
    });
  }
}
