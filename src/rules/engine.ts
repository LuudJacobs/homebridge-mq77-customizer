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
  DEFAULT_RATE_LIMIT_MS,
  DEFAULT_SETTLE_MS,
  RUNAWAY_FIRINGS,
  RUNAWAY_WINDOW_MS,
  type Action,
  type LogEntry,
  type LogOutcome,
  type AnyRule,
  type Branch,
  type MirrorRule,
  type PropertyRef,
  type Rule,
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
      ruleKind: isMirror(rule) ? 'mirror' : 'standard',
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
function nameOf(_branch: Branch, index: number): string {
  return `outcome ${index + 1}`;
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
