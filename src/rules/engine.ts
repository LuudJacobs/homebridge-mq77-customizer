import { EventEmitter } from 'node:events';

import type { Catalog } from '../catalog.js';
import type { Logger } from '../logger.js';
import { writePath } from '../model/payload.js';
import type { NormalisedProperty, StateUpdate } from '../model/types.js';
import type { MqttConnection } from '../mqtt/client.js';
import type { Store } from '../store.js';
import { catalogLookup, evaluate, fromConditions } from './conditions.js';
import { convertValue } from './convert.js';
import type { Place } from './clock.js';
import { isNow, minuteKey, onDay } from './clock.js';
import { describeMatch, holds, matches } from './match.js';
import {
  isMirror,
  isSlider,
  isSunTime,
  isTimeTrigger,
  isTimer,
  DEFAULT_RATE_LIMIT_MS,
  DEFAULT_SETTLE_MS,
  DEFAULT_STEPS,
  DEFAULT_WAIT_MS,
  MAX_WAIT_MS,
  MIN_WAIT_MS,
  MAX_STEPS,
  MIN_STEPS,
  RUNAWAY_FIRINGS,
  RUNAWAY_WINDOW_MS,
  STEP_MEMORY_MS,
  type Action,
  type LogEntry,
  type LogPress,
  type LogOutcome,
  type AnyRule,
  type Branch,
  type MirrorRule,
  type PropertyRef,
  type Match,
  type Rule,
  type AutomationTrigger,
  type LogTime,
  type SliderRule,
  type TimeTrigger,
  type TimerRule,
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

  /** The press the rules are being run for, if a press is what arrived. */
  private pressed?: LogPress;
  /** The time the rules are being run for, if the clock is what reached one. */
  private struck?: LogTime;

  /** Whether any rule answered that press. */
  private answered = false;
  /**
   * The clock, looked at rather than scheduled against.
   *
   * A time trigger is answered by asking, every few seconds, what the local
   * time is now, rather than by working out when the next one falls and
   * waiting for it. That is what makes the two awkward days behave: a time in
   * the hour the clock skips never appears, so it never fires, and a time in
   * the hour the clock repeats appears twice but is remembered as one minute,
   * so it fires once. It also means an edit needs no rescheduling and a
   * restart cannot leave a stale wait behind.
   */
  private readonly ticker: ReturnType<typeof setInterval>;
  /** The last minute each rule fired on, so a repeated minute fires once. */
  private readonly firedAt = new Map<string, string>();
  /** The day each rule last complained about a time nothing can answer. */
  private readonly complained = new Map<string, string>();
  /** When each mirror group was last written to, so it can be left to settle. */
  private readonly settling = new Map<string, number>();
  /** Where each slider was last told to go, and when. See STEP_MEMORY_MS. */
  private readonly steps = new Map<string, { step: number; at: number }>();
  /**
   * Which way a cycle button is going, for the sliders that have one.
   *
   * Nothing kept means upward, which is where it starts and what it goes
   * back to: another of the slider's buttons forgets it here, and a level
   * set anywhere else is noticed on the next press, since the slider is no
   * longer where it left it.
   */
  private readonly cycling = new Map<string, 'up' | 'down'>();
  /** When each cycle button last did something, for its own debounce. */
  private readonly cycled = new Map<string, number>();
  /**
   * What each timer last sent, so its own doing does not start it again.
   *
   * A timer watching for any change and switching a light off hears the
   * light say it is off, reads that as a change, and starts over.
   */
  private readonly echoes = new Map<string, { at: number; keys: Set<string> }>();
  /** Timers counting, by rule, with what set each one off. */
  private readonly waiting = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; trigger: Trigger; startedWith: unknown }
  >();
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(
    private readonly catalog: Catalog,
    private readonly store: Store,
    private readonly mqtt: MqttConnection,
    private readonly log: Logger,
    /** Where the house is, for the rules that follow the sun. */
    private readonly place?: Place,
  ) {
    super();

    this.ticker = setInterval(() => this.readClock(new Date()), CLOCK_TICK_MS);
    // Nothing here should hold Homebridge open on its own.
    this.ticker.unref?.();
  }

  /** The run log, newest first. */
  getLog(): LogEntry[] {
    return [...this.entries].reverse();
  }

  stop(): void {
    clearInterval(this.ticker);
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  /**
   * Fires the automations whose time has come.
   *
   * Public so a test can say what the time is rather than wait for it. The
   * minute a rule fires on is remembered, so a minute that comes round twice
   * on the night the clocks go back fires it once, and a minute that never
   * comes at all on the night they go forward fires it never.
   *
   * Nothing is made up for a minute that passed while the plugin was down:
   * this only ever looks at the minute it is in.
   */
  readClock(at: Date): void {
    for (const rule of this.store.data.rules) {
      if (!rule.enabled || isMirror(rule) || isSlider(rule) || isTimer(rule)) {
        continue;
      }

      const times = triggersOf(rule).filter(isTimeTrigger);
      const due = times.find(
        (trigger) => onDay(trigger.days, at) && isNow(trigger.at, at, this.place, trigger.offset),
      );

      if (!due) {
        // A rule that cannot be answered at all says so, once a day, rather
        // than going quiet: somebody who removed the coordinates should hear
        // about it from the rule that needed them.
        this.sayIfUnanswerable(rule, times, at);
        continue;
      }

      const minute = minuteKey(at);
      if (this.firedAt.get(rule.id) === minute) {
        continue;
      }
      this.firedAt.set(rule.id, minute);

      this.pressed = undefined;
      this.struck = { at: due.at, ...(due.offset ? { offset: due.offset } : {}) };
      this.fire(rule, { property: undefined, value: undefined, time: due });
      this.struck = undefined;
    }
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

    // Held back rather than written down at once: a press that sets a rule off
    // is that rule's line, not a line of its own in front of it.
    const presses = this.pressesIn(update);
    this.pressed = presses[0];
    this.answered = false;

    try {
      this.runRules(rules, update, previously);
    } finally {
      this.pressed = undefined;
    }

    if (!this.answered) {
      for (const press of presses) {
        this.notePress(press);
      }
    }
  }

  /** Every rule's turn at one message. */
  private runRules(
    rules: AnyRule[],
    update: StateUpdate,
    previously: Map<string, unknown>,
  ): void {
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

      if (isTimer(rule)) {
        this.tick(rule, update, previously);
        continue;
      }

      // Any trigger will do, and one message satisfying two of them is still
      // one thing happening.
      for (const trigger of deviceTriggersOf(rule)) {
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
        { copy: { from, to: writes.map((write) => write.member) } },
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

    for (const button of ['up', 'down', 'on', 'off', 'cycle'] as const) {
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

        if (button === 'cycle' && !this.cycleAllowed(rule)) {
          return;
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

    // Any other button of the same slider starts the cycle upward again.
    if (button !== 'cycle') {
      this.cycling.delete(rule.id);
    }

    if (button === 'on' || button === 'off') {
      if (!power?.setTopic) {
        this.record(rule, 'failed', 'nothing on that device can be switched on and off');
        return;
      }
      const wanted = button === 'on' ? power.onValue : power.offValue;
      this.send(power, wanted);
      this.record(rule, 'fired', `switched ${button}`, {
        step: { label: power.label, power: button },
      });
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
    const going = button === 'cycle' ? this.cycleWay(rule, step, ladder) : button;
    const wanted =
      going === 'up'
        ? Math.min(step + 1, ladder.steps)
        : step === 0
          ? 1
          : step - 1;

    if (button === 'cycle') {
      // Where it goes from here, which the next press carries on unless
      // something else has moved the level in the meantime.
      this.cycling.set(rule.id, going);
    }

    if (wanted === step && step === ladder.steps) {
      this.record(rule, 'skipped', `${target.label} is already at the top`, {
        step: { label: target.label, at: 'max' },
      });
      return;
    }

    // Off is a step of its own at the bottom: a light at zero brightness is
    // usually still on, drawing power and looking broken.
    if (wanted === 0) {
      const bottom = {
        label: target.label,
        direction: 'down' as const,
        step: 0,
        steps: ladder.steps,
        at: 'off' as const,
      };
      if (power?.setTopic) {
        this.send(power, power.offValue);
        this.remember(rule, 0);
        this.record(rule, 'fired', `${target.label} stepped down to off`, { step: bottom });
        return;
      }
      this.send(target, ladder.min);
      this.remember(rule, 0);
      this.record(rule, 'fired', `${target.label} down to ${ladder.min}`, {
        step: { ...bottom, level: ladder.min },
      });
      return;
    }

    // Coming on from off lands where the device says it should, since the
    // first step is dim for a light somebody has just asked for. The slider
    // can say instead, for a device that has no opinion.
    const onLevel = rule.onLevel ?? this.deviceOnLevel(rule);
    // Only stepping up lands on the level the device keeps. Down asked for
    // the bottom of the range, not for the light it comes on at.
    // A cycle press is left out: it counts the steps from one end of the
    // range to the other, and coming on somewhere in the middle of them
    // would leave it counting from a step it never sent.
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
        : `${target.label} ${going} to step ${landed} of ${ladder.steps}`,
      {
        step: {
          label: target.label,
          // Coming on where the device says lands on a level rather than a
          // step, and the level is what happened.
          ...(fromOff ? { level } : { direction: going, step: landed, steps: ladder.steps }),
          ...(step === 0 ? { cameOn: true } : {}),
          ...(landed === ladder.steps ? { at: 'max' as const } : {}),
        },
      },
    );
  }

  /**
   * Which way a cycle press goes.
   *
   * Up until the top, down until off, and up again from there. Anywhere in
   * between it carries on the way it was going, but only while the slider is
   * still where it left the light: a level set from HomeKit or a wall switch
   * means somebody else had a hand in it, and the next press starts upward
   * the way the first one does.
   */
  private cycleWay(rule: SliderRule, step: number, ladder: Ladder): 'up' | 'down' {
    if (step >= ladder.steps) {
      return 'down';
    }
    if (step <= 0) {
      return 'up';
    }

    const sent = this.steps.get(rule.id);
    const ours = sent !== undefined && sent.step === step;
    return ours ? (this.cycling.get(rule.id) ?? 'up') : 'up';
  }

  /**
   * A debounce of its own for the cycle button.
   *
   * The stepping buttons deliberately have none, since a held button should
   * run. One button doing the whole range is pressed rather than held, and a
   * remote that sends a press twice would otherwise turn it round.
   */
  private cycleAllowed(rule: SliderRule): boolean {
    const now = Date.now();
    const limit = rule.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS;
    const last = this.cycled.get(rule.id);

    if (last !== undefined && limit > 0 && now - last < limit) {
      this.record(rule, 'rateLimited', `Fired ${now - last}ms ago, minimum ${limit}ms`);
      return false;
    }

    this.cycled.set(rule.id, now);
    return true;
  }

  /**
   * Says when a rule names a time nothing can work out.
   *
   * A sun time with no location is the case worth shouting about: the rule
   * looks fine, and would simply never run. Said once a day rather than four
   * times a minute, and recorded as a failure, which is what the activity
   * list already shows for a rule that cannot do its job.
   */
  private sayIfUnanswerable(rule: Rule, times: TimeTrigger[], at: Date): void {
    const stuck = times.find((trigger) => isSunTime(trigger.at) && !this.place);
    if (!stuck || !onDay(stuck.days, at)) {
      return;
    }

    const today = minuteKey(at).slice(0, 10);
    if (this.complained.get(rule.id) === today) {
      return;
    }
    this.complained.set(rule.id, today);

    this.record(
      rule,
      'failed',
      `${stuck.at} needs a location`,
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

  /**
   * Runs a rule because somebody asked, rather than because something moved.
   *
   * Whether it is switched on does not come into it: the point is to try a
   * rule while building it, which is exactly when it is not yet on. The
   * conditions still hold sway, since a rule that does nothing under the
   * conditions in force is telling you something worth knowing.
   *
   * A timer starts counting rather than acting at once, since starting is
   * what its trigger does.
   */
  /** Empties the run log, for when it is more history than anybody wants. */
  clearLog(): void {
    this.entries.length = 0;
  }

  runNow(ruleId: string): boolean {
    const rule = this.store.data.rules.find((candidate) => candidate.id === ruleId);
    if (!rule || isMirror(rule) || isSlider(rule)) {
      return false;
    }

    // Pretends to be the rule's own trigger holding whatever that device
    // says now, so an action copying the trigger has something to copy. A time
    // trigger holds no value, so the first device one is what is borrowed.
    const trigger = deviceTriggersOf(rule)[0];
    const value = trigger
      ? this.catalog.getState(trigger.sourceId, trigger.deviceId)?.[trigger.propertyKey]
      : undefined;

    if (isTimer(rule)) {
      if (!trigger) {
        return false;
      }
      this.startWaiting(rule, trigger, value);
      return true;
    }

    this.fire(rule, { property: trigger, value });
    return true;
  }

  /**
   * Starts, restarts or calls off a timer.
   *
   * Calling off comes first: a message that takes the value away from what
   * started the wait has ended it, whatever else that message says.
   */
  private tick(rule: TimerRule, update: StateUpdate, previously: Map<string, unknown>): void {
    const running = this.waiting.get(rule.id);
    if (running && refersTo(running.trigger, update, running.trigger.propertyKey)) {
      const value = update.changes[running.trigger.propertyKey];
      if (value !== undefined && !holds(running.trigger.match, value, running.startedWith)) {
        clearTimeout(running.timer);
        this.timers.delete(running.timer);
        this.waiting.delete(rule.id);
        this.record(rule, 'cancelled', `${describeMatch(running.trigger.match)} no longer`);
      }
    }

    for (const trigger of deviceTriggersOf(rule)) {
      if (!(trigger.propertyKey in update.changes)) {
        continue;
      }
      if (!refersTo(trigger, update, trigger.propertyKey)) {
        continue;
      }
      const value = update.changes[trigger.propertyKey];
      const before = previously.get(trigger.propertyKey);
      if (!matches(trigger.match, value, before)) {
        continue;
      }
      if (!justBecameTrue(trigger.match, before)) {
        continue;
      }
      if (this.isOwnDoing(rule, trigger)) {
        continue;
      }
      this.startWaiting(rule, trigger, value);
      return;
    }
  }

  /** True when this timer wrote to that property a moment ago. */
  private isOwnDoing(rule: TimerRule, trigger: Trigger): boolean {
    const echo = this.echoes.get(rule.id);
    if (!echo || Date.now() - echo.at > SELF_ECHO_MS) {
      return false;
    }
    return echo.keys.has(`${trigger.sourceId}:${trigger.deviceId}:${trigger.propertyKey}`);
  }

  private startWaiting(rule: TimerRule, trigger: Trigger, value: unknown): void {
    // The clock starts again rather than running on: a sensor seeing
    // somebody a second time means another full wait, not a shorter one.
    const running = this.waiting.get(rule.id);
    if (running) {
      clearTimeout(running.timer);
      this.timers.delete(running.timer);
    }

    const wait = clampWait(rule.waitMs);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.waiting.delete(rule.id);
      this.fireTimer(rule, trigger, value);
    }, wait);
    this.timers.add(timer);
    this.waiting.set(rule.id, { timer, trigger, startedWith: value });

    const total = Math.round(wait / 1000);
    const clock = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    this.record(rule, 'started', `waiting ${clock}`);
  }

  private fireTimer(rule: TimerRule, trigger: Trigger, value: unknown): void {
    if (!this.allowed(rule)) {
      return;
    }

    const problems: string[] = [];
    for (const action of rule.actions ?? []) {
      const problem = this.run(action, { property: trigger, value });
      if (problem) {
        problems.push(problem);
      }
    }

    if (problems.length > 0) {
      this.record(rule, 'failed', problems.join('; '));
      return;
    }
    // Noted before the devices answer, so their answer is not read as a new
    // reason to start.
    this.echoes.set(rule.id, {
      at: Date.now(),
      keys: new Set(
        (rule.actions ?? []).map(
          (action) => `${action.sourceId}:${action.deviceId}:${action.propertyKey}`,
        ),
      ),
    });

    const count = rule.actions?.length ?? 0;
    this.record(rule, 'fired', `${count} action${count === 1 ? '' : 's'} sent`);
  }

  /**
   * Records a press on a device somebody has marked as a controller.
   *
   * Only those: a marked device is one whose presses are worth watching, and
   * every remote in the house reporting into one list would bury the rules.
   * An empty action is Zigbee2MQTT clearing the last one, not a new press.
   */
  private pressesIn(update: StateUpdate): LogPress[] {
    const device = this.catalog.getDevice(update.sourceId, update.deviceId);
    if (!device) {
      return [];
    }
    const exposure = this.store.getExposure(`${update.sourceId}:${update.deviceId}`);
    if (exposure?.type !== 'controller') {
      return [];
    }

    const presses: LogPress[] = [];
    for (const [propertyKey, value] of Object.entries(update.changes)) {
      const property = device.properties.find((candidate) => candidate.key === propertyKey);
      if (property?.semantic !== 'action' || value === '' || value === undefined) {
        continue;
      }
      presses.push({
        sourceId: update.sourceId,
        deviceId: update.deviceId,
        propertyKey,
        value: String(value),
      });
    }
    return presses;
  }

  private notePress(press: LogPress): void {
    const device = this.catalog.getDevice(press.sourceId, press.deviceId);
    const label =
      device?.properties.find((property) => property.key === press.propertyKey)?.label ??
      press.propertyKey;
    const entry: LogEntry = {
      at: Date.now(),
      ruleId: `${press.sourceId}:${press.deviceId}`,
      ruleName: device?.name ?? press.deviceId,
      ruleKind: 'action',
      outcome: 'fired',
      detail: `${label} ${press.value}`,
      press,
    };
    this.entries.push(entry);
    if (this.entries.length > LOG_SIZE) {
      this.entries.shift();
    }
    this.emit('log', entry);
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
    this.record(rule, 'disabled', 'Fired too often');
  }

  private fire(rule: Rule, trigger: Fired): void {
    const now = Date.now();
    const limit = rule.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS;
    const last = this.lastFired.get(rule.id);

    if (last !== undefined && now - last < limit) {
      this.record(rule, 'rateLimited', `Fired ${now - last}ms ago, minimum ${limit}ms`);
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
    const lookup = catalogLookup(this.catalog, () => new Date(), this.place);
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

    // Named only when there is a choice to name: one branch is just the rule.
    const what = branches.length === 1 ? undefined : nameOf(chosen.branch, chosen.index);
    if (problems.length > 0) {
      this.record(rule, 'failed', problems.join('; '), { branch: what });
      return;
    }

    const count = chosen.branch.actions.length;
    this.record(rule, 'fired', `${count} action${count === 1 ? '' : 's'} sent`, { branch: what });
  }

  /** Returns a problem, or undefined when the action was sent. */
  private run(
    action: Action,
    trigger: Fired,
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
    trigger: Fired,
  ): string | number | boolean | undefined {
    if (action.valueFrom?.kind !== 'trigger') {
      return action.value;
    }
    // A clock holds no value, so there is nothing for such an action to copy.
    if (!trigger.property) {
      return undefined;
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

  private record(
    rule: AnyRule,
    outcome: LogOutcome,
    detail: string,
    parts: Pick<LogEntry, 'branch' | 'step' | 'copy'> = {},
  ): void {
    // A rule that answers a press says so on its own line, and the press does
    // not get one of its own. Two lines for one thing that happened read as
    // two things happening.
    if (this.pressed) {
      this.answered = true;
    }

    const entry: LogEntry = {
      at: Date.now(),
      ruleId: rule.id,
      ruleName: rule.name,
      ruleKind: isMirror(rule)
        ? 'mirror'
        : isSlider(rule)
          ? 'slider'
          : isTimer(rule)
            ? 'timer'
            : 'standard',
      outcome,
      detail,
      ...(this.pressed ? { press: this.pressed } : {}),
      ...(this.struck ? { firedAt: this.struck } : {}),
      ...parts,
    };
    this.entries.push(entry);
    if (this.entries.length > LOG_SIZE) {
      this.entries.shift();
    }
    const said = parts.branch ? `${parts.branch}: ${detail}` : detail;
    if (outcome === 'fired') {
      this.log.info(`Rule "${rule.name}": ${said}`);
    } else {
      this.log.debug(`Rule "${rule.name}" ${outcome}: ${said}`);
    }
    this.emit('log', entry);
  }
}

/**
 * Whether a match has only just come true, rather than being true again.
 *
 * A light saying it is still on is not somebody turning it on. Starting a
 * wait is an event, so `is ON` starts one when the light comes on and not on
 * every message that mentions it, and a stale report after the wait ran does
 * not set the whole thing going a second time.
 */
function justBecameTrue(match: Match, before: unknown): boolean {
  // Nothing known yet, so this is the first anybody has heard of it.
  if (before === undefined) {
    return true;
  }
  // These describe a change already: there is no state to have held.
  if (match.kind === 'changed' || match.kind === 'changedTo') {
    return true;
  }
  return !holds(match, before, before);
}

/**
 * How long a timer disregards its own writes coming back.
 *
 * Long enough for a device to answer, short enough that a person flicking a
 * switch straight afterwards still counts.
 */
const SELF_ECHO_MS = 2000;

/** How often the clock is looked at. Well inside a minute, so none is missed. */
const CLOCK_TICK_MS = 15_000;

/**
 * What set a rule off.
 *
 * A device holding a value, or the clock reaching a time. An action copying
 * the trigger has something to copy in the first case and nothing in the
 * second, which is the whole of the difference here.
 */
interface Fired {
  property?: PropertyRef;
  value: unknown;
  time?: TimeTrigger;
}

/** Keeps a wait inside what the interface offers, whatever was stored. */
function clampWait(waitMs: unknown): number {
  const wanted = typeof waitMs === 'number' ? waitMs : DEFAULT_WAIT_MS;
  return Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, Math.round(wanted)));
}

type SliderButton = 'up' | 'down' | 'on' | 'off' | 'cycle';

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
function triggersOf(rule: Rule | TimerRule): AutomationTrigger[] {
  if (rule.triggers?.length) {
    return rule.triggers;
  }
  if (!('trigger' in rule)) {
    return [];
  }
  return rule.trigger ? [rule.trigger] : [];
}

/**
 * The triggers a message can satisfy, which is all of them but a time.
 *
 * A time trigger is answered by the clock rather than by anything arriving, so
 * it is left out here rather than tested against every message and never
 * matching.
 */
function deviceTriggersOf(rule: Rule | TimerRule): Trigger[] {
  return triggersOf(rule).filter((trigger): trigger is Trigger => !isTimeTrigger(trigger));
}

function refersTo(ref: PropertyRef, update: StateUpdate, propertyKey: string): boolean {
  return (
    ref.sourceId === update.sourceId &&
    ref.deviceId === update.deviceId &&
    ref.propertyKey === propertyKey
  );
}
