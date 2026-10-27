import { describe, expect, it } from 'vitest';

import { openInterface } from './helpers/interface.js';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';

const viewport = (ui: { document: Document }) =>
  ui.document.querySelector('meta[name="viewport"]')?.getAttribute('content');

describe('focusing a field on a phone', () => {
  it('keeps an iPhone at its own scale, so it does not zoom in', async () => {
    const ui = await openInterface({ state: { devices: [] }, userAgent: IPHONE });
    expect(viewport(ui)).toBe('width=device-width, initial-scale=1, maximum-scale=1');
  });

  it('leaves Android alone, which never zooms on focus and would lose its pinch', async () => {
    const ui = await openInterface({ state: { devices: [] }, userAgent: ANDROID });
    expect(viewport(ui)).toBe('width=device-width, initial-scale=1');
  });
});
