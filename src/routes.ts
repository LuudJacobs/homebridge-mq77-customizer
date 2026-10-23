import type { Catalog } from './catalog.js';
import { roleFor } from './homekit/roles.js';
import { toBoolean } from './homekit/values.js';
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

/** What one message says about the motion sensor it came from. */
interface Reading {
  /** Somebody newly noticed: a reading coming on that was off. */
  noticed: boolean;
  /** Whether it said anything about motion or presence at all. */
  moved: boolean;
}

const keyOf = (sensor: Sensor) => `${sensor.sourceId}:${sensor.deviceId}`;

/**
 * Follows walks along the routes, from the motion and presence sensors on
 * them.
 *
 * A walk starts at a route's first sensor and reaches its end once the last
 * one notices somebody, inside the route's time for the whole walk. The ones
 * in between may be missed, since a sensor still reading occupied does not
 * report anybody new, but none may come out of order: one already passed
 * noticing somebody calls the walk off. The first one noticing somebody
 * starts it again from there.
 *
 * Reaching the end is not yet having walked it: that is the last sensor
 * occupied and every other one on the route unoccupied, which is somebody
 * having arrived rather than somebody still on the way or somebody else
 * about. It may be so at once, or once the sensor just left behind clears.
 * The last one clearing first means nobody stayed, and the walk is off.
 *
 * Each way is a walk of its own, so going one way does not get in the way of
 * anybody coming back. Kept while Homebridge runs and no longer.
 */
export class RouteWalks {
  /** Keyed by route and way. */
  private readonly walks = new Map<string, Walk>();
  /** Each motion or presence reading, by sensor, and whether it is on now. */
  private readonly occupancy = new Map<string, Map<string, boolean>>();

  constructor(
    private readonly store: Store,
    private readonly catalog: Catalog,
  ) {}

  /** The routes this message finished a walk along. */
  handleState(update: StateUpdate): Walked[] {
    const reading = this.read(update);
    // A value replayed on connect is not somebody walking past.
    if (update.retained || !reading.moved) {
      return [];
    }

    const sensor = keyOf(update);
    const walked: Walked[] = [];
    for (const route of this.store.data.routes) {
      const ways: Direction[] = route.bothWays ? ['forward', 'back'] : ['forward'];
      for (const direction of ways) {
        const order = direction === 'forward' ? route.sensors : [...route.sensors].reverse();
        const index = order.findIndex((candidate) => keyOf(candidate) === sensor);
        if (index < 0) {
          continue;
        }
        const key = `${route.id}:${direction}`;
        if (reading.noticed) {
          this.step(route, key, index, update.at);
        }
        if (this.arrived(key, order)) {
          walked.push({ route, direction });
        }
      }
    }
    return walked;
  }

  /** Moves a walk along, or calls it off. */
  private step(route: Route, key: string, index: number, at: number): void {
    if (index === 0) {
      this.walks.set(key, { index, startedAt: at });
      return;
    }
    const walk = this.walks.get(key);
    if (!walk || index < walk.index || (index > walk.index && at - walk.startedAt > route.walkMs)) {
      this.walks.delete(key);
      return;
    }
    walk.index = index;
  }

  /**
   * Whether a walk that reached the end has now been walked, the last sensor
   * occupied and the rest of them clear. One whose last sensor cleared first
   * is called off.
   */
  private arrived(key: string, order: Sensor[]): boolean {
    const walk = this.walks.get(key);
    const last = order.length - 1;
    if (!walk || walk.index !== last) {
      return false;
    }
    if (!this.occupied(order[last]!)) {
      this.walks.delete(key);
      return false;
    }
    if (order.slice(0, last).some((sensor) => this.occupied(sensor))) {
      return false;
    }
    this.walks.delete(key);
    return true;
  }

  private occupied(sensor: Sensor): boolean {
    return [...(this.occupancy.get(keyOf(sensor))?.values() ?? [])].some(Boolean);
  }

  /**
   * What a message says about motion or presence, kept for the sensor.
   * Noticing is a reading coming on rather than being on, since a sensor
   * still reading occupied repeats it with every other thing it reports.
   */
  private read(update: StateUpdate): Reading {
    const device = this.catalog.getDevice(update.sourceId, update.deviceId);
    const reading: Reading = { noticed: false, moved: false };
    if (!device) {
      return reading;
    }
    const sensor = keyOf(update);
    for (const [key, value] of Object.entries(update.changes)) {
      const property = device.properties.find((candidate) => candidate.key === key);
      const role = property ? roleFor(property) : undefined;
      if (!property || value === undefined || value === null) {
        continue;
      }
      if (role !== 'motion' && role !== 'occupancy') {
        continue;
      }
      const now = toBoolean(property, value);
      const readings = this.occupancy.get(sensor) ?? new Map<string, boolean>();
      reading.noticed ||= now && readings.get(key) !== true;
      reading.moved = true;
      readings.set(key, now);
      this.occupancy.set(sensor, readings);
    }
    return reading;
  }
}
