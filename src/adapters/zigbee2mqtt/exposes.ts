import type {
  NormalisedProperty,
  PropertyCategory,
  PropertyType,
} from '../../model/types.js';
import {
  ACCESS_PUBLISHED,
  ACCESS_SET,
  SPECIFIC_TYPES,
  type Z2mExpose,
} from './protocol.js';

const LEAF_TYPES: Record<string, PropertyType> = {
  binary: 'binary',
  numeric: 'numeric',
  enum: 'enum',
  text: 'text',
};

interface FlattenContext {
  stateTopic: string;
  setTopic: string;
  /** Payload path accumulated from enclosing composites. */
  path: string[];
  endpoint?: string;
  group?: string;
  category?: PropertyCategory;
  /** Types encountered that we do not handle, collected for the caller to log. */
  unsupported: string[];
}

/**
 * Flattens a device's exposes tree into normalised properties.
 *
 * The tree has two nesting rules and they differ. A specific type (`light`,
 * `climate`, ...) holds its features flat in the payload, so they keep their
 * own top level property name. A `composite` nests its features underneath its
 * own property, so those need the composite's name in their path.
 */
export function flattenExposes(
  exposes: Z2mExpose[],
  options: { stateTopic: string; setTopic: string },
): { properties: NormalisedProperty[]; unsupported: string[] } {
  const context: FlattenContext = {
    stateTopic: options.stateTopic,
    setTopic: options.setTopic,
    path: [],
    unsupported: [],
  };

  const properties: NormalisedProperty[] = [];
  for (const expose of exposes) {
    walk(expose, context, properties);
  }

  // A device can expose the same property twice, for instance once inside a
  // specific type and once standalone. First definition wins.
  const seen = new Set<string>();
  const deduped = properties.filter((property) => {
    if (seen.has(property.key)) {
      return false;
    }
    seen.add(property.key);
    return true;
  });

  return { properties: deduped, unsupported: [...new Set(context.unsupported)] };
}

function walk(expose: Z2mExpose, context: FlattenContext, out: NormalisedProperty[]): void {
  const endpoint = expose.endpoint ?? context.endpoint;
  const category = expose.category ?? context.category;

  if (SPECIFIC_TYPES.has(expose.type)) {
    // Features sit flat in the payload, so the path does not grow.
    for (const feature of expose.features ?? []) {
      walk(feature, { ...context, endpoint, category, group: expose.type }, out);
    }
    return;
  }

  if (expose.type === 'composite') {
    if (!expose.property) {
      context.unsupported.push('composite without property');
      return;
    }
    // Features nest underneath the composite's own property.
    const nested: FlattenContext = {
      ...context,
      path: [...context.path, expose.property],
      endpoint,
      category,
      group: expose.label ?? expose.name ?? expose.property,
    };
    for (const feature of expose.features ?? []) {
      walk(feature, nested, out);
    }
    return;
  }

  const type = LEAF_TYPES[expose.type];
  if (!type) {
    context.unsupported.push(expose.type);
    return;
  }

  const property = toProperty(expose, type, { ...context, endpoint, category });
  if (property) {
    out.push(property);
  }
}

function toProperty(
  expose: Z2mExpose,
  type: PropertyType,
  context: FlattenContext,
): NormalisedProperty | undefined {
  if (!expose.property) {
    context.unsupported.push(`${expose.type} without property`);
    return undefined;
  }

  const extract = [...context.path, expose.property];
  const access = expose.access ?? ACCESS_PUBLISHED;
  const writable = (access & ACCESS_SET) !== 0;

  return {
    key: extract.join('.'),
    label: expose.label ?? expose.name ?? expose.property,
    semantic: expose.name,
    type,
    access: {
      readable: (access & ACCESS_PUBLISHED) !== 0,
      writable,
    },
    category: context.category ?? 'primary',
    unit: expose.unit,
    min: expose.value_min,
    max: expose.value_max,
    step: expose.value_step,
    values: expose.values,
    onValue: expose.value_on,
    offValue: expose.value_off,
    toggleValue: expose.value_toggle,
    endpoint: context.endpoint,
    group: context.group,
    stateTopic: context.stateTopic,
    setTopic: writable ? context.setTopic : undefined,
    extract,
  };
}
