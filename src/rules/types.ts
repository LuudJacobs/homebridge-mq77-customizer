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

/**
 * A condition, which may be a whole expression rather than a single test.
 *
 * Stored to any depth. The editor offers two levels, an `any` of `all` groups,
 * which loses nothing: every boolean expression can be written that way, so
 * `(A and B) or (C and (D and E))` is `(A and B) or (C and D and E)`.
 */
export type ConditionNode =
  | { kind: 'all'; nodes: ConditionNode[] }
  | { kind: 'any'; nodes: ConditionNode[] }
  | { kind: 'not'; node: ConditionNode }
  | ({ kind: 'test' } & Condition);

/**
 * Where an action's value comes from.
 *
 * `trigger` copies whatever set the rule off, translated into the target's own
 * terms, which is how one device is made to follow another.
 */
export type ValueSource = { kind: 'literal' } | { kind: 'trigger' };

export interface Action extends PropertyRef {
  /** Used when the value is a literal, which is the default. */
  value?: string | number | boolean;
  valueFrom?: ValueSource;
  /** Wait this long before sending. */
  delayMs?: number;
}

export interface Rule {
  id: string;
  kind?: 'standard';
  name: string;
  enabled: boolean;
  /**
   * Any of these fires the rule.
   *
   * `trigger` is what earlier versions stored, a single one. It is read as a
   * list of one and rewritten on next save.
   */
  triggers?: Trigger[];
  trigger?: Trigger;
  /**
   * Tested against the values currently known, when present.
   *
   * `conditions` is what earlier versions stored, a flat list meaning all of
   * them. It is read as a single `all` node and rewritten on next save.
   */
  when?: ConditionNode;
  conditions?: Condition[];
  actions: Action[];
  /**
   * Shortest gap between firings.
   *
   * Also the backstop against a loop: two rules that trigger each other
   * cannot run away faster than this.
   */
  rateLimitMs?: number;
}

/**
 * Keeps a set of properties equal to each other.
 *
 * Not expressible as a trigger and an action, because every member is both.
 * Each group is one thing being kept in sync, so a pair of devices can mirror
 * their on/off state and their brightness as one rule.
 */
export interface MirrorRule {
  id: string;
  kind: 'mirror';
  name: string;
  enabled: boolean;
  groups: PropertyRef[][];
  rateLimitMs?: number;
  /** How long the group is left alone after a write. See DEFAULT_SETTLE_MS. */
  settleMs?: number;
}

export type AnyRule = Rule | MirrorRule;

export function isMirror(rule: AnyRule): rule is MirrorRule {
  return rule.kind === 'mirror';
}

export type LogOutcome = 'fired' | 'rateLimited' | 'conditionsFailed' | 'failed' | 'disabled';

export interface LogEntry {
  at: number;
  ruleId: string;
  ruleName: string;
  /** Which list the rule lives in, so the run log can be split the same way. */
  ruleKind: 'standard' | 'mirror';
  outcome: LogOutcome;
  /** Why, in a sentence, for the run log in the interface. */
  detail: string;
}

export const DEFAULT_RATE_LIMIT_MS = 1000;

/**
 * How long a mirror group is left alone after it has been written to.
 *
 * Long enough for a device to act and report back, short enough that flipping
 * a switch twice still feels responsive.
 */
export const DEFAULT_SETTLE_MS = 1500;

/**
 * The shortest window worth having.
 *
 * Below this a pair of devices that disagree can trade places fast enough to
 * look like a runaway, which is the fault this window exists to prevent.
 */
export const MIN_SETTLE_MS = 250;
export const MAX_SETTLE_MS = 60_000;

/** Firing more often than this in the window below means something is looping. */
export const RUNAWAY_FIRINGS = 20;
export const RUNAWAY_WINDOW_MS = 10_000;
