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

/**
 * One outcome of a rule, and the condition that chooses it.
 *
 * The first branch whose condition holds runs, and the rest are skipped. A
 * branch with no condition always holds, so anything after it is unreachable.
 * That is allowed: it is the author's business, and a rule that does nothing
 * is a legitimate thing to have half built.
 */
export interface Branch {
  /** A note from whoever wrote the rule. Nothing evaluates it. */
  label?: string;
  when?: ConditionNode;
  actions: Action[];
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
  /**
   * Tried in order, the first that holds wins.
   *
   * `when` and `actions` are what earlier versions stored, a single outcome.
   * They are read as one branch and rewritten on next save.
   */
  branches?: Branch[];
  when?: ConditionNode;
  conditions?: Condition[];
  actions?: Action[];
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

/**
 * A dimmer driven by buttons.
 *
 * The same thing written as automations is four to six rules that only make
 * sense together, so it is one object: the level to drive, how many steps it
 * has, and the buttons that move it. The device itself stays an ordinary
 * device, usable in automations and mirror groups as before.
 */
export interface SliderRule {
  id: string;
  kind: 'slider';
  name: string;
  enabled: boolean;
  /** The numeric property being driven, brightness or speed. */
  target: PropertyRef;
  /** The on/off property of the same device, for the ends of the range. */
  power?: PropertyRef;
  /** How many steps from off to full. */
  steps: number;
  /** Caps the range below what the device allows. */
  max?: number;
  /**
   * Where it lands when it comes on from off.
   *
   * Without one it comes on at the first step, which is dim for a light
   * somebody wanted on. A device with a level of its own to fall back on is
   * a different thing: this is what the slider sends, not what the device
   * does when a wall switch is used.
   */
  onLevel?: number;
  /** Any of these presses moves it, so one slider can take several remotes. */
  up?: Trigger[];
  down?: Trigger[];
  on?: Trigger[];
  off?: Trigger[];
  rateLimitMs?: number;
}

export type AnyRule = Rule | MirrorRule | SliderRule;

export function isSlider(rule: AnyRule): rule is SliderRule {
  return (rule as SliderRule).kind === 'slider';
}

export function isMirror(rule: AnyRule): rule is MirrorRule {
  return rule.kind === 'mirror';
}

export type LogOutcome =
  | 'fired'
  | 'rateLimited'
  | 'conditionsFailed'
  | 'failed'
  | 'disabled'
  /** Nothing to do: a slider already at the end of its range. */
  | 'skipped';

export interface LogEntry {
  at: number;
  ruleId: string;
  ruleName: string;
  /** Which list the rule lives in, so the run log can be split the same way. */
  /** `action` is not a rule at all, but a button press worth seeing. */
  ruleKind: 'standard' | 'mirror' | 'slider' | 'action';
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
/** Fewest steps a slider can have, since one step is a switch. */
export const MIN_STEPS = 2;
export const MAX_STEPS = 20;
export const DEFAULT_STEPS = 5;

/**
 * How long a press keeps stepping from where the last one left it.
 *
 * A held button sends faster than a light reports back, so reading the
 * device each time would compute every press from the same value and move
 * one step in total.
 */
export const STEP_MEMORY_MS = 2500;

export const MIN_SETTLE_MS = 250;
export const MAX_SETTLE_MS = 60_000;

/** Firing more often than this in the window below means something is looping. */
export const RUNAWAY_FIRINGS = 20;
export const RUNAWAY_WINDOW_MS = 10_000;
