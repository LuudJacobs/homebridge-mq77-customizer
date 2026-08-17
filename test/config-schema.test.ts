import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

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

  it('offers every adapter the plugin can actually load', () => {
    const [, adapter] = properties(schema.schema).find(([path]) => path === 'sources.[].adapter')!;
    const offered = (adapter.oneOf as { enum: string[] }[]).flatMap((option) => option.enum);
    expect(offered).toEqual(['zigbee2mqtt']);
  });
});
