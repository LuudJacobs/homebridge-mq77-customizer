import type { Catalog } from './catalog.js';
import { roleFor } from './homekit/roles.js';
import { isShut, toBoolean } from './homekit/values.js';
import type { StateUpdate } from './model/types.js';
import type { Route, Store } from './store.js';

/** How long a new route gives somebody from its first sensor to its last. */
export const DEFAULT_WALK_MS = 30_000;

/** Along the sensors in the order they are listed, or back the other way. */
export type Direction = 'forward' | 'back';

type Sensor = Route['sensors'][number];

/** A route walked from one end to the other, and which way. */
export interface Walked {
  route: Route;
  direction: Direction;
}

/** A walk under way: the sensor passed last, and when the first one was. */
interface Walk {
  index: number;
  startedAt: number;
}

const keyOf = (sensor: Sensor) => `${sensor.sourceId}:${sensor.deviceId}`;

/**
 * Follows walks along the routes, from the sensors on them.
 *
 * A walk starts at a route's first sensor and is walked once its last one
 * notices somebody, inside the route's time for the whole walk. The ones in
 * between may be missed, since a motion sensor still reading occupied does
 * not report anybody new, but none may come out of order: one already passed
 * noticing somebody calls the walk off. The first one noticing somebody
 * starts it again from there. Each way is a walk of its own, so going one way
 * does not get in the way of anybody coming back.
 *
 * Kept while Homebridge runs and no longer: a walk is seconds long.
 */
export class RouteWalks {
  /** Keyed by route and way. */
  private readonly walks = new Map<string, Walk>();
  /** Whether each reading that notices somebody is noticing them now. */
  private readonly noticing = new Map<string, boolean>();

  constructor(
    private readonly store: Store,
    private readonly catalog: Catalog,
  ) {}

  /** The routes this message finished a walk along. */
  handleState(update: StateUpdate): Walked[] {
    const noticed = this.noticed(update);
    // A value replayed on connect is not somebody walking past.
    if (update.retained || !noticed) {
      return [];
    }

    const sensor = keyOf(update);
    const walked: Walked[] = [];
    for (const route of this.store.data.routes) {
      const ways: Direction[] = route.bothWays ? ['forward', 'back'] : ['forward'];
      for (const direction of ways) {
        const order = direction === 'forward' ? route.sensors : [...route.sensors].reverse();
        const index = order.findIndex((candidate) => keyOf(candidate) === sensor);
        if (index >= 0 && this.step(route, direction, index, order.length, update.at)) {
          walked.push({ route, direction });
        }
      }
    }
    return walked;
  }

  /** Moves a walk along, and says whether that finished it. */
  private step(
    route: Route,
    direction: Direction,
    index: number,
    length: number,
    at: number,
  ): boolean {
    const key = `${route.id}:${direction}`;
    if (index === 0) {
      this.walks.set(key, { index, startedAt: at });
      return false;
    }

    const walk = this.walks.get(key);
    if (!walk || at - walk.startedAt > route.walkMs || index < walk.index) {
      this.walks.delete(key);
      return false;
    }
    if (index === length - 1) {
      this.walks.delete(key);
      return true;
    }
    walk.index = index;
    return false;
  }

  /**
   * Whether a message has somebody being noticed: motion or presence coming
   * on, a door opening. Coming on rather than being on, since a sensor still
   * reading occupied repeats it with every other thing it reports.
   */
  private noticed(update: StateUpdate): boolean {
    const device = this.catalog.getDevice(update.sourceId, update.deviceId);
    if (!device) {
      return false;
    }
    let noticed = false;
    for (const [key, value] of Object.entries(update.changes)) {
      const property = device.properties.find((candidate) => candidate.key === key);
      const role = property ? roleFor(property) : undefined;
      if (!property || value === undefined || value === null) {
        continue;
      }
      let now: boolean;
      if (role === 'motion' || role === 'occupancy') {
        now = toBoolean(property, value);
      } else if (role === 'contact') {
        now = !isShut(value);
      } else {
        continue;
      }
      const reading = `${keyOf(update)}:${key}`;
      noticed ||= now && this.noticing.get(reading) !== true;
      this.noticing.set(reading, now);
    }
    return noticed;
  }
}
