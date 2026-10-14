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

  it('shows the logo in both headers, using the shipped favicon', () => {
    const logos = [...html.matchAll(/<img[^>]*class="logo"[^>]*src="\/([^"]+)"/g)].map(
      (match) => match[1],
    );
    // One on the login screen, one in the signed in header.
    expect(logos).toEqual(['favicon.svg', 'favicon.svg']);
  });

  it('points at a favicon that is actually shipped', () => {
    const icon = html.match(/rel="icon"[^>]*href="\/([^"]+)"/)?.[1];
    expect(icon).toBe('favicon.svg');
    expect(() =>
      readFileSync(fileURLToPath(new URL(`../src/web/public/${icon}`, import.meta.url))),
    ).not.toThrow();
  });

  it('gives an iPhone or iPad a home screen icon it can use', () => {
    const href = html.match(/rel="apple-touch-icon"[^>]*href="\/([^"]+)"/)?.[1];
    expect(href).toBe('apple-touch-icon.png');

    const png = readFileSync(fileURLToPath(new URL(`../src/web/public/${href}`, import.meta.url)));
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
    // 180 square, which is what iOS asks for.
    expect(png.readUInt32BE(16)).toBe(180);
    expect(png.readUInt32BE(20)).toBe(180);
    // Nothing see-through: no alpha channel (colour types 4 and 6) and no
    // transparency chunk, since iOS fills transparency with black and rounds
    // the corners itself.
    expect([4, 6]).not.toContain(png[25]);
    expect(png.includes(Buffer.from('tRNS'))).toBe(false);
  });
});
