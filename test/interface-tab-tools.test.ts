import { describe, expect, it } from 'vitest';

import { openInterface } from './helpers/interface.js';

async function open() {
  return openInterface({ state: { devices: [] } });
}

const line = (ui: { document: Document }, view: string) =>
  ui.document.querySelector(`#view-${view} .rules-actions`) as HTMLElement;

describe('the controls of a tab', () => {
  it('sit on the open tab’s button line, before its buttons, and nowhere in the header', async () => {
    const ui = await open();
    const tools = ui.document.getElementById('tab-tools')!;
    expect(tools.parentElement).toBe(line(ui, 'devices'));
    expect(tools.nextElementSibling?.classList.contains('tab-buttons')).toBe(true);
    expect(ui.document.querySelector('header #sort, header #filter')).toBeNull();
  });

  it('go along to the tab that is opened, checkboxes and all', async () => {
    const ui = await open();
    await ui.click(ui.byText('button.tab', 'Log'));
    const tools = ui.document.getElementById('tab-tools')!;
    expect(tools.parentElement).toBe(line(ui, 'activity'));
    expect((ui.document.getElementById('kind-filters') as HTMLElement).hidden).toBe(false);

    await ui.click(ui.byText('button.tab', 'Guide'));
    expect(tools.parentElement).toBe(line(ui, 'controllers'));
    expect((ui.document.getElementById('unused-buttons-filter') as HTMLElement).hidden).toBe(false);
  });

  it('leave nothing in front of the buttons where there is nothing to sort or filter', async () => {
    const ui = await open();
    await ui.click(ui.byText('button.tab', 'Home'));
    expect((ui.document.getElementById('tab-tools') as HTMLElement).hidden).toBe(true);
  });

  it('have no line of explanation above them any more', async () => {
    const ui = await open();
    expect(ui.document.querySelectorAll('section > p.hint')).toHaveLength(0);
  });
});
