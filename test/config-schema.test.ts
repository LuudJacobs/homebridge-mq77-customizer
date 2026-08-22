import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { adapterNames } from '../src/adapters/index.js';
import { PLATFORM_NAME } from '../src/settings.js';

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL('../config.schema.json', import.meta.url)), 'utf8'),
) as Record<string, any>;

/** Every leaf property in the schema, keyed by its path. */
function properties(node: any, path = ''): [string, any][] {
  if (typeof node !== 'object' || node === null) {
    return [];
  }
  const found: [string, any][] = [];
  for (const [name, value] of Object.entries(node.properties ?? {})) {
    const child = value as any;
    found.push([`${path}${name}`, child]);
    found.push(...properties(child, `${path}${name}.`));
  }
  if (node.items) {
    found.push(...properties(node.items, `${path}[].`));
  }
  return found;
}

describe('config.schema.json', () => {
  it('declares the platform Homebridge registers', () => {
    expect(schema.pluginAlias).toBe(PLATFORM_NAME);
    expect(schema.pluginType).toBe('platform');
  });

  it('renders bounded numbers as input fields rather than sliders', () => {
    // Homebridge's config UI turns an integer with both a minimum and a
    // maximum into a slider, which is useless for something like a port.
    // `x-schema-form` overrides the widget while keeping the validation.
    const sliders = properties(schema.schema)
      .filter(
        ([, property]) =>
          (property.type === 'integer' || property.multipleOf !== undefined) &&
          property.minimum !== undefined &&
          property.maximum !== undefined &&
          property['x-schema-form']?.type === undefined,
      )
      .map(([path]) => path);

    expect(sliders).toEqual([]);
  });

  it('shows adapter specific fields only for that adapter', () => {
    for (const name of ['topics', 'setTopicSuffix', 'devices']) {
      const [, field] = properties(schema.schema).find(([path]) => path.endsWith(`.${name}`))!;
      // Otherwise a Zigbee2MQTT source offers two fields that do nothing.
      expect(field.condition?.functionBody).toContain("adapter === 'json-topic'");
      expect(field.description ?? '').not.toContain('Flat JSON sources only');
    }
  });

  it('asks for the credentials only when authentication is ticked', () => {
    for (const name of ['broker.username', 'broker.password']) {
      const [, field] = properties(schema.schema).find(([path]) => path === name)!;
      expect(field.condition?.functionBody).toContain('requiresAuth');
    }
  });

  it('asks for the broker as one address rather than a host and a port', () => {
    const paths = properties(schema.schema).map(([path]) => path);
    expect(paths).toContain('broker.address');
    expect(paths).not.toContain('broker.host');
    expect(paths).not.toContain('broker.port');
  });

  it('masks password fields, since format alone does not do it in this UI', () => {
    const plain = properties(schema.schema)
      .filter(([path, property]) => /password/i.test(path) && property['x-schema-form']?.type !== 'password')
      .map(([path]) => path);
    expect(plain).toEqual([]);
  });

  it('asks for a web password, since the interface will not start without one', () => {
    const [, password] = properties(schema.schema).find(([path]) => path === 'web.password')!;
    expect(password.required).toBe(true);
  });

  it('lays out every field, since a layout replaces the automatic form', () => {
    // Naming a layout means fields are shown because they are listed, not
    // because they exist. One left out disappears from the config UI without
    // any sign of it, so this is the thing that says so.
    const keys = new Set<string>();
    const walk = (nodes: any[]) => {
      for (const node of nodes) {
        if (typeof node === 'string') {
          keys.add(node);
        } else {
          if (node.key) {
            keys.add(node.key);
          }
          walk(node.items ?? []);
        }
      }
    };
    walk(schema.layout);

    // A field is covered by itself or by any parent that is laid out whole.
    const covered = (path: string) => {
      const key = path.replace(/\.\[\]/g, '[]');
      return [...keys].some(
        (laid) => key === laid || key.startsWith(`${laid}.`) || key.startsWith(`${laid}[]`),
      );
    };

    // Only the fields someone fills in. A container is covered by its
    // children being laid out one by one.
    const isLeaf = (property: any) =>
      property.properties === undefined && property.items?.properties === undefined;

    const missing = properties(schema.schema)
      .filter(([, property]) => isLeaf(property))
      .map(([path]) => path)
      .filter((path) => !covered(path));

    expect(missing).toEqual([]);
  });

  it('makes the described devices array itself the panel', () => {
    const panel = schema.layout
      .flatMap((node: any) => (node.key === 'sources' ? node.items : []))
      .find((node: any) => node.title === 'Described devices');

    expect(panel).toBeDefined();
    // Collapsed to start with, since most sources never describe anything.
    expect(panel.expandable).toBe(true);
    expect(panel.expanded).toBe(false);
    // One title, on the panel, and none on the array under it.
    const [, devices] = properties(schema.schema).find(([path]) => path === 'sources.[].devices')!;
    expect(devices.title).toBeUndefined();
  });

  it('conditions only what carries an array index', () => {
    // `arrayIndices` is bound to a node with a key. On a wrapper without one
    // the condition cannot be worked out, and the whole node disappears
    // rather than failing loudly, which is how the panel went missing.
    const check = (nodes: any[]) => {
      for (const node of nodes) {
        if (typeof node === 'string') {
          continue;
        }
        if (node.condition?.functionBody?.includes('arrayIndices')) {
          expect(node.key, `condition on ${node.title ?? node.type}`).toBeDefined();
        }
        check(node.items ?? []);
      }
    };
    check(schema.layout);
  });

  it('offers every adapter the plugin can actually load', () => {
    const [, adapter] = properties(schema.schema).find(([path]) => path === 'sources.[].adapter')!;
    const offered = (adapter.oneOf as { enum: string[] }[]).flatMap((option) => option.enum);
    // Compared against the registry rather than a copy of it, so adding an
    // adapter without offering it in the config UI fails here.
    expect(offered.sort()).toEqual([...adapterNames()].sort());
  });
});
