/**
 * Warns when a battery runs low.
 *
 * A battery is low when the device says so, through `battery_low` or
 * `low_battery`, or when `battery` drops below ten percent. A device that
 * counts its battery is warned about three times on the way down, below 10,
 * at 5 and at 1; one that only raises a flag is warned about once.
 *
 * What was sent is kept in memory, not with the settings, so a restart with a
 * battery still low warns about it once more. A battery that comes back up
 * starts the count again, which is what replacing one looks like.
 */
import type { Catalog } from './catalog.js';
import type { Logger } from './logger.js';
import type { StateUpdate } from './model/types.js';
import type { Notifier } from './rules/ntfy.js';
import type { Store } from './store.js';

/** The properties that say a battery is low, in the words devices use. */
export const LOW_FLAGS = ['battery_low', 'low_battery'];
/** The property that counts what is left, in percent. */
export const PERCENTAGE = 'battery';

/** Below this, a counted battery is low. */
const LOW_BELOW = 10;

export interface BatteryReading {
  low: boolean;
  /** What is left, where the device counts it. */
  percent?: number;
}

/** Whether a device has anything to say about its battery at all. */
export function hasBattery(keys: Iterable<string>): boolean {
  for (const key of keys) {
    if (key === PERCENTAGE || LOW_FLAGS.includes(key)) {
      return true;
    }
  }
  return false;
}

/** What a device's state says about its battery. */
export function readBattery(state: Readonly<Record<string, unknown>> | undefined): BatteryReading {
  const raw = state?.[PERCENTAGE];
  const percent = typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
  const flagged = LOW_FLAGS.some((flag) => state?.[flag] === true);
  return {
    low: flagged || (percent !== undefined && percent < LOW_BELOW),
    ...(percent === undefined ? {} : { percent }),
  };
}

/**
 * How far down a battery is: nothing, then one warning per step.
 *
 * A flag with no number, or a number that disagrees with it, is one step.
 */
export function stageOf(reading: BatteryReading): number {
  if (!reading.low) {
    return 0;
  }
  const percent = reading.percent;
  if (percent === undefined || percent >= LOW_BELOW) {
    return 1;
  }
  if (percent <= 1) {
    return 3;
  }
  if (percent <= 5) {
    return 2;
  }
  return 1;
}

export class BatteryWatch {
  /** The step each device was last warned at. */
  private readonly warned = new Map<string, number>();

  constructor(
    private readonly catalog: Catalog,
    private readonly store: Store,
    private readonly notifier: Notifier,
    private readonly log: Logger,
  ) {}

  /**
   * Looks at a message for a battery going down.
   *
   * Retained ones count: after a restart, the broker replaying a low battery
   * is the only way of hearing about it again.
   */
  handleState(update: StateUpdate): void {
    if (!hasBattery(Object.keys(update.changes))) {
      return;
    }

    const key = `${update.sourceId}:${update.deviceId}`;
    const stage = stageOf(readBattery(this.catalog.getState(update.sourceId, update.deviceId)));
    const before = this.warned.get(key) ?? 0;

    if (stage === 0) {
      this.warned.delete(key);
      return;
    }
    if (stage <= before) {
      return;
    }
    this.warned.set(key, stage);

    // Remembered as warned either way, so ticking the box again while a
    // battery is flat does not set off a warning nobody asked for just then.
    if (this.store.getExposure(key)?.batteryWarning === false) {
      return;
    }

    const reading = readBattery(this.catalog.getState(update.sourceId, update.deviceId));
    const name = this.nameOf(update.sourceId, update.deviceId);
    const counted = reading.percent !== undefined && reading.percent < LOW_BELOW;
    const title = `${name} is low on battery`;
    const message = counted
      ? `Battery for ${name} is at ${reading.percent}%.`
      : `Battery for ${name} is low.`;

    this.notifier.send(title, message).catch((error: unknown) => {
      this.log.warn(
        `Low battery warning for ${name} not sent: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  /** A device as it is named here: its room and label, or what the source calls it. */
  private nameOf(sourceId: string, deviceId: string): string {
    const exposure = this.store.getExposure(`${sourceId}:${deviceId}`);
    const device = this.catalog.getDevice(sourceId, deviceId);
    const name = exposure?.label || device?.name || deviceId;
    return exposure?.room ? `${exposure.room} ${name}` : name;
  }
}
