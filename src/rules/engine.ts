import { EventEmitter } from 'node:events';

import type { Catalog } from '../catalog.js';
import type { Logger } from '../logger.js';
import { writePath } from '../model/payload.js';
import type { NormalisedProperty, StateUpdate } from '../model/types.js';
import type { MqttConnection } from '../mqtt/client.js';
import type { Store } from '../store.js';
import { describeMatch, matches } from './match.js';
import {
  DEFAULT_RATE_LIMIT_MS,
  RUNAWAY_FIRINGS,
  RUNAWAY_WINDOW_MS,
  type Action,
  type LogEntry,
  type LogOutcome,
  type PropertyRef,
  type Rule,
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

    for (const [propertyKey, value] of Object.entries(update.changes)) {
      const cacheKey = `${update.sourceId}:${update.deviceId}:${propertyKey}`;
      const previous = this.previous.get(cacheKey);
      this.previous.set(cacheKey, value);

      // A retained message is the broker replaying something that already
      // happened. Acting on it would fire every rule again on each reconnect.
      if (update.retained) {
        continue;
      }

      for (const rule of rules) {
        if (!rule.enabled || !refersTo(rule.trigger, update, propertyKey)) {
          continue;
        }
        if (!matches(rule.trigger.match, value, previous)) {
          continue;
        }
        this.fire(rule);
      }
    }
  }

  private fire(rule: Rule): void {
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
      return;
    }

    const failed = this.checkConditions(rule);
    if (failed) {
      this.record(rule, 'conditionsFailed', failed);
      return;
    }

    this.lastFired.set(rule.id, now);

    const problems: string[] = [];
    for (const action of rule.actions) {
      const problem = this.run(action);
      if (problem) {
        problems.push(problem);
      }
    }

    if (problems.length > 0) {
      this.record(rule, 'failed', problems.join('; '));
      return;
    }

    this.record(rule, 'fired', `${rule.actions.length} action${rule.actions.length === 1 ? '' : 's'} sent`);
  }

  /** Returns why the conditions did not hold, or undefined when they did. */
  private checkConditions(rule: Rule): string | undefined {
    for (const condition of rule.conditions) {
      const property = this.property(condition);
      if (!property) {
        return `${condition.propertyKey} is not on that device any more`;
      }
      const state = this.catalog.getState(condition.sourceId, condition.deviceId);
      const value = state?.[condition.propertyKey];
      if (value === undefined) {
        return `no value known yet for ${condition.propertyKey}`;
      }
      if (!matches(condition.match, value)) {
        return `${property.label} ${describeMatch(condition.match)} did not hold`;
      }
    }
    return undefined;
  }

  /** Returns a problem, or undefined when the action was sent. */
  private run(action: Action): string | undefined {
    const property = this.property(action);
    if (!property) {
      return `${action.propertyKey} is not on that device any more`;
    }
    if (!property.setTopic) {
      return `${property.label} cannot be written to`;
    }

    const payload = JSON.stringify(writePath(property.encode ?? property.extract, action.value));

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

  private isRunaway(rule: Rule, now: number): boolean {
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

  private record(rule: Rule, outcome: LogOutcome, detail: string): void {
    const entry: LogEntry = { at: Date.now(), ruleId: rule.id, ruleName: rule.name, outcome, detail };
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

function refersTo(ref: PropertyRef, update: StateUpdate, propertyKey: string): boolean {
  return (
    ref.sourceId === update.sourceId &&
    ref.deviceId === update.deviceId &&
    ref.propertyKey === propertyKey
  );
}
