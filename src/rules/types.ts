/** How a value is tested, both for triggers and for conditions. */
export type Match =
  | { kind: 'changed' }
  | { kind: 'equals'; value: string | number | boolean }
  | { kind: 'notEquals'; value: string | number | boolean }
  | { kind: 'changedTo'; value: string | number | boolean }
  | { kind: 'above'; value: number }
  | { kind: 'below'; value: number };

/** Points at one property of one device, on any source. */
export interface PropertyRef {
  sourceId: string;
  deviceId: string;
  propertyKey: string;
}

export interface Trigger extends PropertyRef {
  match: Match;
}

export interface Condition extends PropertyRef {
  match: Match;
}

export interface Action extends PropertyRef {
  /** Sent as the property's wire value. */
  value: string | number | boolean;
  /** Wait this long before sending. */
  delayMs?: number;
}

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  /** All must hold, tested against the values currently known. */
  conditions: Condition[];
  actions: Action[];
  /**
   * Shortest gap between firings.
   *
   * Also the backstop against a loop: two rules that trigger each other
   * cannot run away faster than this.
   */
  rateLimitMs?: number;
}

export type LogOutcome = 'fired' | 'rateLimited' | 'conditionsFailed' | 'failed' | 'disabled';

export interface LogEntry {
  at: number;
  ruleId: string;
  ruleName: string;
  outcome: LogOutcome;
  /** Why, in a sentence, for the run log in the interface. */
  detail: string;
}

export const DEFAULT_RATE_LIMIT_MS = 1000;

/** Firing more often than this in the window below means something is looping. */
export const RUNAWAY_FIRINGS = 20;
export const RUNAWAY_WINDOW_MS = 10_000;
