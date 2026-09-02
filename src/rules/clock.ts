/**
 * Times of day, read against whatever the machine thinks the local time is.
 *
 * Everything here works on the local clock rather than on a count of
 * milliseconds, which is what makes the two awkward days fall out on their
 * own. On the day the clock goes forward a time in the missing hour never
 * appears as a local `HH:MM`, so a rule set for it does not fire; on the day
 * it goes back the same `HH:MM` appears twice an hour apart, and firing is
 * remembered against the minute so it happens once.
 */
import { getTimes } from 'suncalc';

import type { SunTime, TimeWindow, Weekday } from './types.js';
import { isSunTime, WEEKDAYS } from './types.js';

/** Where the house is, for the times the sun decides. */
export interface Place {
  latitude: number;
  longitude: number;
}

/** The day of the week, in the words a rule stores. */
export function weekdayOf(at: Date): Weekday {
  // getDay counts from Sunday, and a week is read from Monday.
  return WEEKDAYS[(at.getDay() + 6) % 7] as Weekday;
}

/** Minutes since midnight, which is what a comparison wants. */
export function minutesOf(at: Date): number {
  return at.getHours() * 60 + at.getMinutes();
}

/**
 * What a named time comes to today, at this place, offset and all.
 *
 * Worked out for the day rather than once, since they move a minute or two
 * daily. Nothing comes back on a day where the sun does not reach that point
 * at all: far enough north, dusk and dawn go missing for weeks around
 * midsummer long before sunrise and sunset do.
 */
export function sunTimeOn(name: SunTime, at: Date, place: Place, offset = 0): Date | undefined {
  const times = getTimes(at, place.latitude, place.longitude);
  const found = times[name];
  if (!(found instanceof Date) || Number.isNaN(found.getTime())) {
    return undefined;
  }
  return new Date(found.getTime() + offset * 60_000);
}

/**
 * The minute a trigger names, whether it says it in numbers or in daylight.
 *
 * A clock time is what it says. A sun time is looked up for the day the
 * question is asked about, which is why the place has to be known before one
 * can be answered at all.
 */
export function minutesFor(
  at: string,
  when: Date,
  place: Place | undefined,
  offset = 0,
): number | undefined {
  if (isSunTime(at)) {
    if (!place) {
      return undefined;
    }
    const found = sunTimeOn(at, when, place, offset);
    return found ? minutesOf(found) : undefined;
  }
  return minutesFrom(at);
}

/** `HH:MM` as a rule stores it, or undefined if it is not one. */
export function minutesFrom(time: string): number | undefined {
  const read = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time.trim());
  if (!read) {
    return undefined;
  }
  return Number(read[1]) * 60 + Number(read[2]);
}

/** The stamp a firing is remembered against: a date and a minute of it. */
export function minuteKey(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** Whether a rule set for these days may run today. */
export function onDay(days: Weekday[] | undefined, at: Date): boolean {
  return !days?.length || days.includes(weekdayOf(at));
}

/**
 * Whether the clock has reached the minute a trigger names.
 *
 * The minute rather than the instant: a rule set for 07:00 fires once during
 * that minute, wherever in it the check happens to land.
 */
export function isNow(time: string, at: Date, place?: Place, offset = 0): boolean {
  const wanted = minutesFor(time, at, place, offset);
  return wanted !== undefined && wanted === minutesOf(at);
}

/**
 * Whether the time of day sits inside a window.
 *
 * A window may cross midnight: 22:00 to 06:00 is the night rather than
 * nothing at all. Equal ends are the whole day rather than an instant, since
 * a window of no length is not a thing anybody means to set.
 *
 * The day is the day the window opens on. A night window that began on Friday
 * still holds at one in the morning on Saturday, which is what somebody
 * picking Friday night means.
 */
export function inWindow(window: TimeWindow, at: Date, place?: Place): boolean {
  const from = minutesFor(window.from, at, place, window.fromOffset ?? 0);
  const to = minutesFor(window.to, at, place, window.toOffset ?? 0);
  if (from === undefined || to === undefined) {
    return false;
  }

  const now = minutesOf(at);

  if (from === to) {
    return onDay(window.days, at);
  }

  if (from < to) {
    return now >= from && now < to && onDay(window.days, at);
  }

  // Crosses midnight, so it is two pieces: this evening, or this morning
  // carried over from yesterday evening.
  if (now >= from) {
    return onDay(window.days, at);
  }
  if (now < to) {
    const yesterday = new Date(at.getTime());
    yesterday.setDate(yesterday.getDate() - 1);
    return onDay(window.days, yesterday);
  }
  return false;
}

/** A time as the interface and the run log say it. */
export function describeTime(time: string, offset?: number): string {
  if (!offset) {
    return time;
  }
  const sign = offset < 0 ? '-' : '+';
  const total = Math.abs(offset);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${time} ${sign}${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}
