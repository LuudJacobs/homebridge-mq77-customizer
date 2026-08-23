import { EventEmitter } from 'node:events';

import type { Catalog } from '../catalog.js';
import type { Logger } from '../logger.js';
import { writePath } from '../model/payload.js';
import type { NormalisedProperty, StateUpdate } from '../model/types.js';
import type { MqttConnection } from '../mqtt/client.js';
import type { Store } from '../store.js';
import { catalogLookup, evaluate, fromConditions } from './conditions.js';
import { convertValue } from './convert.js';
import { describeMatch, matches } from './match.js';
import {
  isMirror,
  isSlider,
  DEFAULT_RATE_LIMIT_MS,
  DEFAULT_SETTLE_MS,
  DEFAULT_STEPS,
  MAX_STEPS,
  MIN_STEPS,
  RUNAWAY_FIRINGS,
  RUNAWAY_WINDOW_MS,
  STEP_MEMORY_MS,
  type Action,
  type LogEntry,
  type LogOutcome,
  type AnyRule,
  type Branch,
  type MirrorRule,
  type PropertyRef,
  type Rule,
  type SliderRule,
  type Trigger,
} from './types.js';

const LOG_SIZE = 200;



export interface EngineEvents {
  /** A rule ran, or declined to. */
  log: [LogEntry];
}

/**
 * Runs the rules.
 *
 * Rules are read from the store on every update rather than cached, so
 * editing one takes effect on the next message with no reload step.
 */
export class RulesEngine extends EventEmitter<EngineEvents> {
  /** Last value seen per property, so a rule can tell a change from a repeat. */
  private readonly previous = new Map<string, unknown>();
  private readonly lastFired = new Map<string, number>();
  /** Firing times per rule, trimmed to the runaway window. */
  private readonly recentFirings = new Map<string, number[]>();
  private readonly entries: LogEntry[] = [];
  /** When each mirror group was last written to, so it can be left to settle. */
  private readonly settling = new Map<string, number>();
  /** Where each slider was last told to go, and when. See STEP_MEMORY_MS. */
  private readonly steps = new Map<string, { step: number; at: number }>();
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(
    private readonly catalog: Catalog,
    private readonly store: Store,
    private readonly mqtt: MqttConnection,
    private readonly log: Logger,
  ) {
    super();
  }

  /** The run log, newest first. */
  getLog(): LogEntry[] {
    return [...this.entries].reverse();
  }

  stop(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  handleState(update: StateUpdate): void {
    const rules = this.store.data.rules;

    // Captured before anything is overwritten, since a rule asking whether a
    // value changed needs what it was a moment ago.
    const previously = new Map<string, unknown>();
    for (const [propertyKey, value] of Object.entries(update.changes)) {
      const cacheKey = `${update.sourceId}:${update.deviceId}:${propertyKey}`;
      previously.set(propertyKey, this.previous.get(cacheKey));
      this.previous.set(cacheKey, value);
    }

    // A retained message is the broker replaying something that already
    // happened. Acting on it would fire every rule again on each reconnect.
    if (update.retained) {
      return;
    }

    for (const rule of rules) {
      if (!rule.enabled) {
        continue;
      }

      if (isMirror(rule)) {
        for (const [propertyKey, value] of Object.entries(update.changes)) {
          this.mirror(rule, update, propertyKey, value);
        }
        continue;
      }

      if (isSlider(rule)) {
        this.slide(rule, update, previously);
        continue;
      }

      // Any trigger will do, and one message satisfying two of them is still
      // one thing happening.
      for (const trigger of triggersOf(rule)) {
        if (!(trigger.propertyKey in update.changes)) {
          continue;
        }
        if (!refersTo(trigger, update, trigger.propertyKey)) {
          continue;
        }
        const value = update.changes[trigger.propertyKey];
        if (!matches(trigger.match, value, previously.get(trigger.propertyKey))) {
          continue;
        }
        this.fire(rule, { property: trigger, value });
        break;
      }
    }
  }

  /**
   * Brings the rest of a group into line with the member that just changed.
   *
   * A member that already holds the value is left alone, which is what stops
   * mirroring looping: the device we write to reports back, that report
   * mirrors again, and every other member is by then already equal, so
   * nothing is sent and it stops after one round.
   */
  /*
   * Acting on the first thing heard from a device was tried and taken out
   * again. Zigbee2MQTT does not retain state, so after a restart the first
   * report from each member reads as a change and the group is written to,
   * which looks like a rule firing on startup.
   *
   * Ignoring it costs more than it saves: nothing is known after a restart,
   * so the first real change gets swallowed too, and a member that has not
   * spoken since cannot be written to at all. A quiet startup is not worth a
   * mirror that misses the first press.
   */
  private mirror(
    rule: MirrorRule,
    update: StateUpdate,
    propertyKey: string,
    value: unknown,
  ): void {
    for (const [index, group] of rule.groups.entries()) {
      const from = group.find((member) => refersTo(member, update, propertyKey));
      if (!from) {
        continue;
      }
      const source = this.property(from);
      if (!source) {
        continue;
      }

      // Every report during the settling window is either the confirmation we
      // were waiting for or the stale one that would send us backwards, and
      // acting on either is wrong.
      const groupKey = `${rule.id}:${index}`;
      const wroteAt = this.settling.get(groupKey);
      if (wroteAt !== undefined && Date.now() - wroteAt < (rule.settleMs ?? DEFAULT_SETTLE_MS)) {
        continue;
      }

      const problems: string[] = [];
      const writes: { member: PropertyRef; target: NormalisedProperty; wanted: unknown }[] = [];

      for (const member of group) {
        if (member === from) {
          continue;
        }
        const target = this.property(member);
        if (!target) {
          problems.push(`${member.propertyKey} is not on that device any more`);
          continue;
        }
        if (!target.setTopic) {
          problems.push(`${target.label} cannot be written to`);
          continue;
        }

        const wanted = convertValue(source, target, value);
        if (wanted === undefined) {
          continue;
        }

        const current = this.catalog.getState(member.sourceId, member.deviceId)?.[
          member.propertyKey
        ];
        if (
          current !== undefined &&
          matches({ kind: 'equals', value: wanted as string | number | boolean }, current)
        ) {
          continue;
        }

        writes.push({ member, target, wanted });
      }

      if (problems.length > 0) {
        this.record(rule, 'failed', problems.join('; '));
      }

      // Nothing to do is the usual outcome once everything agrees, and it is
      // not a firing. Counting it would retire a working rule.
      if (writes.length === 0) {
        continue;
      }

      if (!this.allowed(rule)) {
        return;
      }

      this.settling.set(groupKey, Date.now());

      for (const write of writes) {
        this.mqtt.publish(
          write.target.setTopic as string,
          JSON.stringify(writePath(write.target.encode ?? write.target.extract, write.wanted)),
        );
      }

      this.record(
        rule,
        'fired',
        `${source.label} copied to ${writes.map((write) => write.target.label).join(', ')}`,
      );
    }
  }

  /**
   * Moves a dimmer when one of its buttons is pressed.
   *
   * The four buttons are checked in turn and the first that matches wins, so
   * one press does one thing however the buttons are set up.
   */
  private slide(rule: SliderRule, update: StateUpdate, previously: Map<string, unknown>): void {
    const target = this.property(rule.target);
    if (!target) {
      return;
    }

    for (const button of ['up', 'down', 'on', 'off'] as const) {
      // Any of a button's triggers presses it, and one message satisfying two
      // of them is still one press.
      for (const trigger of buttonTriggers(rule, button)) {
        if (!(trigger.propertyKey in update.changes)) {
          continue;
        }
        if (!refersTo(trigger, update, trigger.propertyKey)) {
          continue;
        }
        const value = update.changes[trigger.propertyKey];
        if (!matches(trigger.match, value, previously.get(trigger.propertyKey))) {
          continue;
        }

        if (!this.allowed(rule)) {
          return;
        }
        this.press(rule, target, button);
        return;
      }
    }
  }

  private press(rule: SliderRule, target: NormalisedProperty, button: SliderButton): void {
    const power = rule.power && this.property(rule.power);

    if (button === 'on' || button === 'off') {
      if (!power?.setTopic) {
        this.record(rule, 'failed', 'nothing on that device can be switched on and off');
        return;
      }
      const wanted = button === 'on' ? power.onValue : power.offValue;
      this.send(power, wanted);
      this.record(rule, 'fired', `switched ${button}`);
      return;
    }

    if (!target.setTopic) {
      this.record(rule, 'failed', `${target.label} cannot be written to`);
      return;
    }

    const ladder = stepsOf(rule, target);
    const step = this.stepNow(rule, target, ladder);

    // Down from off comes on at the bottom of the range. Somebody pressing a
    // button at a dark light wants light, and the dimmest step is what down
    // means when there is nothing below it.
    const wanted =
      button === 'up'
        ? Math.min(step + 1, ladder.steps)
        : step === 0
          ? 1
          : step - 1;

    if (wanted === step && step === ladder.steps) {
      this.record(rule, 'skipped', `${target.label} is already at the top`);
      return;
    }

    // Off is a step of its own at the bottom: a light at zero brightness is
    // usually still on, drawing power and looking broken.
    if (wanted === 0) {
      if (power?.setTopic) {
        this.send(power, power.offValue);
        this.remember(rule, 0);
        this.record(rule, 'fired', `${target.label} stepped down to off`);
        return;
      }
      this.send(target, ladder.min);
      this.remember(rule, 0);
      this.record(rule, 'fired', `${target.label} down to ${ladder.min}`);
      return;
    }

    // Coming on from off lands where the device says it should, since the
    // first step is dim for a light somebody has just asked for. The slider
    // can say instead, for a device that has no opinion.
    const onLevel = rule.onLevel ?? this.deviceOnLevel(rule);
    // Only stepping up lands on the level the device keeps. Down asked for
    // the bottom of the range, not for the light it comes on at.
    const fromOff = button === 'up' && step === 0 && onLevel !== undefined;
    const level = fromOff ? clampLevel(onLevel as number, ladder) : levelAt(wanted, ladder);
    const landed = fromOff ? stepFor(level, ladder) : wanted;

    // The light has to be told to come on as well. Many devices do that
    // themselves on a brightness write, and the ones that do not would
    // otherwise take the level and stay dark.
    if (step === 0 && power?.setTopic) {
      this.send(power, power.onValue);
    }
    this.send(target, level);
    this.remember(rule, landed);
    this.record(
      rule,
      'fired',
      fromOff
        ? `${target.label} on at ${level}`
        : `${target.label} ${button} to step ${landed} of ${ladder.steps}`,
    );
  }

  /**
   * Which step the dimmer is on, counted from what it was last told.
   *
   * A held button sends faster than a light reports back, so within the
   * memory window a press carries on from the last one. After that the
   * device is believed, since somebody may have changed it another way.
   */
  private stepNow(rule: SliderRule, target: NormalisedProperty, ladder: Ladder): number {
    const remembered = this.steps.get(rule.id);
    if (remembered && Date.now() - remembered.at < STEP_MEMORY_MS) {
      return remembered.step;
    }

    const power = rule.power && this.property(rule.power);
    const powerState =
      rule.power && this.catalog.getState(rule.power.sourceId, rule.power.deviceId)?.[
        rule.power.propertyKey
      ];
    if (power && powerState !== undefined && powerState === power.offValue) {
      return 0;
    }

    const current = this.catalog.getState(rule.target.sourceId, rule.target.deviceId)?.[
      rule.target.propertyKey
    ];
    if (typeof current !== 'number') {
      // Never reported, so there is nothing to count from. Treated as off,
      // which makes the first press a step up to one.
      return 0;
    }

    const above = (current - ladder.min) / (ladder.max - ladder.min || 1);
    return Math.max(0, Math.min(ladder.steps, Math.round(above * ladder.steps)));
    // Rounded to the nearest step on purpose: a level set elsewhere snaps to
    // the ladder before it moves, which is easier to predict than landing
    // between steps.
  }

  /**
   * The level the device itself comes on at, when it keeps one.
   *
   * Zigbee2MQTT calls it `level_config.on_level`. A device that has it set
   * already knows the answer, so asking for it twice would only be a second
   * place to keep it up to date.
   */
  private deviceOnLevel(rule: SliderRule): number | undefined {
    const device = this.catalog.getDevice(rule.target.sourceId, rule.target.deviceId);
    const property = device?.properties.find((candidate) => candidate.key.endsWith('on_level'));
    if (!property) {
      return undefined;
    }
    const value = this.catalog.getState(rule.target.sourceId, rule.target.deviceId)?.[property.key];
    return typeof value === 'number' ? value : undefined;
  }

  private remember(rule: SliderRule, step: number): void {
    this.steps.set(rule.id, { step, at: Date.now() });
  }

  private send(property: NormalisedProperty, value: unknown): void {
    this.mqtt.publish(
      property.setTopic as string,
      JSON.stringify(writePath(property.encode ?? property.extract, value)),
    );
  }

  /** Shared rate limit and runaway guard, for whichever kind of rule. */
  private allowed(rule: AnyRule): boolean {
    const now = Date.now();
    const limit = rule.rateLimitMs ?? 0;
    const last = this.lastFired.get(rule.id);
    if (last !== undefined && limit > 0 && now - last < limit) {
      return false;
    }
    if (this.isRunaway(rule, now)) {
      this.disable(rule);
      return false;
    }
    this.lastFired.set(rule.id, now);
    return true;
  }

  private disable(rule: AnyRule): void {
    this.store.update((state) => {
      const stored = state.rules.find((candidate) => candidate.id === rule.id);
      if (stored) {
        stored.enabled = false;
      }
    });
    this.log.error(
      `Rule "${rule.name}" fired ${RUNAWAY_FIRINGS} times in ${RUNAWAY_WINDOW_MS / 1000}s and has been turned off. It is probably triggering itself.`,
    );
    this.record(rule, 'disabled', 'Fired too often, so it was turned off. Check it is not triggering itself');
  }

  private fire(rule: Rule, trigger: { property: PropertyRef; value: unknown }): void {
    const now = Date.now();
    const limit = rule.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS;
    const last = this.lastFired.get(rule.id);

    if (last !== undefined && now - last < limit) {
      this.record(rule, 'rateLimited', `Fired ${now - last}ms ago, waiting ${limit}ms between runs`);
      return;
    }

    if (this.isRunaway(rule, now)) {
      // Two rules triggering each other would otherwise saturate the broker.
      // Turning it off is louder than letting it churn quietly.
      this.disable(rule);
      return;
    }

    // The first branch that holds wins, the rest are skipped. That is what
    // makes else if exclusive by construction rather than by hand.
    const lookup = catalogLookup(this.catalog);
    const branches = branchesOf(rule);
    const declined: string[] = [];
    let chosen: { branch: Branch; index: number } | undefined;

    for (const [index, branch] of branches.entries()) {
      const failed = evaluate(branch.when, lookup);
      if (!failed) {
        chosen = { branch, index };
        break;
      }
      declined.push(`${nameOf(branch, index)}: ${failed.detail}`);
    }

    if (!chosen) {
      // Not a failure. A rule whose every branch declined has done its job.
      this.record(rule, 'conditionsFailed', declined.join('; ') || 'no branch matched');
      return;
    }

    this.lastFired.set(rule.id, now);

    const problems: string[] = [];
    for (const action of chosen.branch.actions) {
      const problem = this.run(action, trigger);
      if (problem) {
        problems.push(problem);
      }
    }

    const what = nameOf(chosen.branch, chosen.index);
    if (problems.length > 0) {
      this.record(rule, 'failed', `${what}: ${problems.join('; ')}`);
      return;
    }

    const count = chosen.branch.actions.length;
    this.record(
      rule,
      'fired',
      branches.length === 1
        ? `${count} action${count === 1 ? '' : 's'} sent`
        : `${what}, ${count} action${count === 1 ? '' : 's'} sent`,
    );
  }

  /** Returns a problem, or undefined when the action was sent. */
  private run(
    action: Action,
    trigger: { property: PropertyRef; value: unknown },
  ): string | undefined {
    const property = this.property(action);
    if (!property) {
      return `${action.propertyKey} is not on that device any more`;
    }
    if (!property.setTopic) {
      return `${property.label} cannot be written to`;
    }

    const value = this.resolve(action, property, trigger);
    if (value === undefined) {
      return `nothing to send to ${property.label}`;
    }

    const payload = JSON.stringify(writePath(property.encode ?? property.extract, value));

    if (!action.delayMs) {
      this.mqtt.publish(property.setTopic, payload);
      return undefined;
    }

    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.mqtt.publish(property.setTopic as string, payload);
    }, action.delayMs);
    this.timers.add(timer);
    return undefined;
  }

  /**
   * Works out what to send, translating a copied value into the target's terms.
   *
   * A switch that says `"ON"` can drive one that expects `true`, and a dimmer
   * counting to 254 can drive one counting to 100.
   */
  private resolve(
    action: Action,
    target: NormalisedProperty,
    trigger: { property: PropertyRef; value: unknown },
  ): string | number | boolean | undefined {
    if (action.valueFrom?.kind !== 'trigger') {
      return action.value;
    }
    const source = this.property(trigger.property);
    if (!source) {
      return undefined;
    }
    return convertValue(source, target, trigger.value);
  }

  private isRunaway(rule: AnyRule, now: number): boolean {
    const times = (this.recentFirings.get(rule.id) ?? []).filter(
      (at) => now - at < RUNAWAY_WINDOW_MS,
    );
    times.push(now);
    this.recentFirings.set(rule.id, times);
    return times.length > RUNAWAY_FIRINGS;
  }

  private property(ref: PropertyRef): NormalisedProperty | undefined {
    return this.catalog
      .getDevice(ref.sourceId, ref.deviceId)
      ?.properties.find((property) => property.key === ref.propertyKey);
  }

  private record(rule: AnyRule, outcome: LogOutcome, detail: string): void {
    const entry: LogEntry = {
      at: Date.now(),
      ruleId: rule.id,
      ruleName: rule.name,
      ruleKind: isMirror(rule) ? 'mirror' : isSlider(rule) ? 'slider' : 'standard',
      outcome,
      detail,
    };
    this.entries.push(entry);
    if (this.entries.length > LOG_SIZE) {
      this.entries.shift();
    }
    if (outcome === 'fired') {
      this.log.info(`Rule "${rule.name}": ${detail}`);
    } else {
      this.log.debug(`Rule "${rule.name}" ${outcome}: ${detail}`);
    }
    this.emit('log', entry);
  }
}

type SliderButton = 'up' | 'down' | 'on' | 'off';

interface Ladder {
  min: number;
  max: number;
  steps: number;
}

/** The range a slider covers, and how many steps it is cut into. */
function stepsOf(rule: SliderRule, target: NormalisedProperty): Ladder {
  const min = target.min ?? 0;
  const ceiling = target.max ?? 100;
  return {
    min,
    max: Math.min(rule.max ?? ceiling, ceiling),
    steps: Math.max(MIN_STEPS, Math.min(MAX_STEPS, Math.round(rule.steps || DEFAULT_STEPS))),
  };
}

/** What to send for a given step, rounded to something a device will take. */
function levelAt(step: number, ladder: Ladder): number {
  const span = ladder.max - ladder.min;
  return Math.round(ladder.min + (span * step) / ladder.steps);
}

/** A button's triggers, reading what earlier versions stored as a single one. */
function buttonTriggers(rule: SliderRule, button: SliderButton): Trigger[] {
  const given = rule[button] as Trigger[] | Trigger | undefined;
  if (!given) {
    return [];
  }
  return Array.isArray(given) ? given : [given];
}

function clampLevel(level: number, ladder: Ladder): number {
  return Math.round(Math.max(ladder.min, Math.min(ladder.max, level)));
}

/** The nearest step to a level, so a press from there carries on sensibly. */
function stepFor(level: number, ladder: Ladder): number {
  const above = (level - ladder.min) / (ladder.max - ladder.min || 1);
  return Math.max(1, Math.min(ladder.steps, Math.round(above * ladder.steps)));
}

/** A rule's branches, reading what earlier versions stored as a single one. */
function branchesOf(rule: Rule): Branch[] {
  if (rule.branches?.length) {
    return rule.branches;
  }
  return [
    {
      when: rule.when ?? fromConditions(rule.conditions),
      actions: rule.actions ?? [],
    },
  ];
}

/** What to call an outcome in the activity list. */
function nameOf(branch: Branch, index: number): string {
  // Whatever it was called, since that is what the run log is read for.
  return branch.label ?? `outcome ${index + 1}`;
}

/** A rule's triggers, reading what earlier versions stored as a list of one. */
function triggersOf(rule: Rule): Trigger[] {
  if (rule.triggers?.length) {
    return rule.triggers;
  }
  return rule.trigger ? [rule.trigger] : [];
}

function refersTo(ref: PropertyRef, update: StateUpdate, propertyKey: string): boolean {
  return (
    ref.sourceId === update.sourceId &&
    ref.deviceId === update.deviceId &&
    ref.propertyKey === propertyKey
  );
}
