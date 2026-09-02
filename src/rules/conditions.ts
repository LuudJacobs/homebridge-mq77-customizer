import type { Catalog } from '../catalog.js';
import type { NormalisedProperty } from '../model/types.js';
import type { Place } from './clock.js';
import { describeTime, onSide } from './clock.js';
import { describeMatch, matches } from './match.js';
import type { Condition, ConditionNode, PropertyRef, TimeCondition } from './types.js';

export interface Reason {
  /** Why the expression did not hold, in a sentence for the run log. */
  detail: string;
}

interface Lookup {
  property(ref: PropertyRef): NormalisedProperty | undefined;
  value(ref: PropertyRef): unknown;
  /** What the clock says, for a condition that asks the time. */
  now?(): Date;
  /** Where the house is, for a window whose ends the sun decides. */
  place?: Place;
}

/**
 * Tests an expression, saying why when it does not hold.
 *
 * The reason matters as much as the answer: a rule that quietly declines to
 * run is the hardest kind to work out, and "the hall light is not off" is the
 * whole of the explanation.
 */
export function evaluate(node: ConditionNode | undefined, lookup: Lookup): Reason | undefined {
  if (!node) {
    return undefined;
  }

  switch (node.kind) {
    case 'test':
      return test(node, lookup);

    case 'time':
      return timeOfDay(node, lookup);

    case 'all': {
      for (const child of node.nodes) {
        const failed = evaluate(child, lookup);
        if (failed) {
          return failed;
        }
      }
      return undefined;
    }

    case 'any': {
      if (node.nodes.length === 0) {
        return undefined;
      }
      const reasons: string[] = [];
      for (const child of node.nodes) {
        const failed = evaluate(child, lookup);
        if (!failed) {
          return undefined;
        }
        reasons.push(failed.detail);
      }
      // Every branch of an or failed, so all of them are the reason.
      return { detail: `none held: ${reasons.join('; ')}` };
    }

    case 'not': {
      const failed = evaluate(node.node, lookup);
      return failed ? undefined : { detail: `${describe(node.node, lookup)} held, and should not have` };
    }

    default:
      return { detail: 'unknown condition' };
  }
}

/**
 * Whether the clock is on the side of the time this names.
 *
 * The reason says the condition rather than the hour it was, since a rule
 * that declined at ten past midnight is read the next morning, when what it
 * said about "now" would be about a different now.
 */
function timeOfDay(node: TimeCondition, lookup: Lookup): Reason | undefined {
  const at = lookup.now?.() ?? new Date();
  if (onSide(node, at, lookup.place)) {
    return undefined;
  }
  return { detail: `not ${node.side} ${describeTime(node.at, node.offset)}` };
}

function test(node: { kind: 'test' } & Condition, lookup: Lookup): Reason | undefined {
  const property = lookup.property(node);
  if (!property) {
    return { detail: `${node.propertyKey} is not on that device any more` };
  }

  const value = lookup.value(node);
  if (value === undefined) {
    return { detail: `no value known yet for ${property.label}` };
  }

  return matches(node.match, value)
    ? undefined
    : { detail: `${property.label} ${describeMatch(node.match)} did not hold` };
}

/** Describes an expression in words, for a reason or for the interface. */
export function describe(node: ConditionNode, lookup?: Lookup): string {
  switch (node.kind) {
    case 'test': {
      const label = lookup?.property(node)?.label ?? node.propertyKey;
      return `${label} ${describeMatch(node.match)}`;
    }
    case 'all':
      return node.nodes.map((child) => describe(child, lookup)).join(' and ');
    case 'any':
      return node.nodes.map((child) => describe(child, lookup)).join(' or ');
    case 'not':
      return `not (${describe(node.node, lookup)})`;
    case 'time':
      return `${node.side} ${describeTime(node.at, node.offset)}`;
    default:
      return 'an unknown condition';
  }
}

/** Reads what earlier versions stored, a flat list meaning all of them. */
export function fromConditions(conditions: Condition[] | undefined): ConditionNode | undefined {
  if (!conditions?.length) {
    return undefined;
  }
  return { kind: 'all', nodes: conditions.map((condition) => ({ kind: 'test', ...condition })) };
}

/** Builds the lookup the evaluator needs from the catalog. */
export function catalogLookup(catalog: Catalog, now?: () => Date, place?: Place): Lookup {
  return {
    property: (ref) =>
      catalog
        .getDevice(ref.sourceId, ref.deviceId)
        ?.properties.find((property) => property.key === ref.propertyKey),
    value: (ref) => catalog.getState(ref.sourceId, ref.deviceId)?.[ref.propertyKey],
    now,
    place,
  };
}
