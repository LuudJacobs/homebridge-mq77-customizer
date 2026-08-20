import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { JSDOM, VirtualConsole } from 'jsdom';

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/web/public/${name}`, import.meta.url)), 'utf8');

export interface Snapshot {
  devices: unknown[];
  tileTypes?: string[];
  links?: Record<string, string>;
}

/**
 * Loads the real interface into a document.
 *
 * The editor is a few hundred lines of DOM building with no framework and no
 * types, which is exactly the kind of code that goes wrong quietly. Running it
 * for real is the only way to know it still works.
 */
export async function openInterface(options: { state: Snapshot; rules?: unknown[] }) {
  // Anything the page throws is collected rather than swallowed, since a
  // handler that fails silently is the whole difficulty with this code.
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error: Error) => errors.push(String(error)));
  virtualConsole.on('error', (...args: unknown[]) => errors.push(args.map(String).join(' ')));

  const dom = new JSDOM(read('index.html'), {
    runScripts: 'outside-only',
    url: 'http://localhost/',
    virtualConsole,
  });
  const { window } = dom;

  const responses: Record<string, unknown> = {
    '/api/state': { tileTypes: ['Switch', 'Outlet', 'Lightbulb', 'Fan'], ...options.state },
    '/api/rules': { rules: options.rules ?? [] },
    '/api/log': { entries: [] },
  };

  const requests: { path: string; body: unknown }[] = [];

  window.fetch = ((path: string, init?: { method?: string; body?: string }) => {
    requests.push({ path, body: init?.body ? JSON.parse(init.body) : undefined });
    const body = responses[path] ?? { ok: true };
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
      headers: { getSetCookie: () => [] },
    });
  }) as never;

  // Browsers have had this since 2022, jsdom does not expose it. Without it
  // the rule editor fails on its first line and the whole list goes blank.
  (window as unknown as { structuredClone: unknown }).structuredClone = structuredClone;

  // Nothing here depends on live updates, and jsdom has no EventSource.
  (window as unknown as { EventSource: unknown }).EventSource = class {
    onopen: unknown;
    onerror: unknown;
    onmessage: unknown;
  };

  window.eval(read('app.js'));
  await settle(window);

  return {
    window,
    document: window.document,
    requests,
    errors,
    settle: () => settle(window),
    click: async (node: Element | null) => {
      (node as HTMLElement).click();
      await settle(window);
    },
    /** Buttons and tabs are found by what they say, as a person would. */
    byText: (selector: string, text: string, within?: string) =>
      [...(within ? window.document.querySelector(within)! : window.document).querySelectorAll(
        selector,
      )].find((node) => node.textContent?.trim() === text) ?? null,
  };
}

/**
 * Lets the interface finish reacting.
 *
 * Opening a tab starts two fetches and renders once both land, so a single
 * turn of the loop is not enough to see the result.
 */
async function settle(window: { setTimeout: typeof setTimeout }): Promise<void> {
  for (let turn = 0; turn < 8; turn++) {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}
