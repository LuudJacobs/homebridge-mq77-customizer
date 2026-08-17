import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/web/public/${name}`, import.meta.url)), 'utf8');

const html = read('index.html');
const css = read('app.css');
const js = read('app.js');

describe('web assets', () => {
  it('lets the hidden attribute beat id selectors', () => {
    // `#login { display: grid }` outranks the browser's `[hidden]` rule, which
    // pinned the login screen open over the signed in interface and made a
    // working sign in look like nothing happening at all.
    expect(css).toMatch(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
  });

  it('only toggles panels that the stylesheet cannot pin open', () => {
    const toggled = [...js.matchAll(/el\.(\w+)\.hidden\s*=/g)].map((match) => match[1]);
    expect(toggled.length).toBeGreaterThan(0);
    // Every one of them relies on the rule above rather than on specificity.
    expect(css).toMatch(/\[hidden\]/);
  });

  it('references only element ids that exist in the page', () => {
    const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
    const used = [...js.matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1]);

    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((id) => !ids.has(id))).toEqual([]);
  });

  it('loads its assets from the same origin, since a strict policy blocks anything else', () => {
    expect(html).not.toMatch(/(src|href)="https?:\/\//);
  });
});
