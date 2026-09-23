import { describe, expect, it } from 'vitest';

import { openInterface } from './helpers/interface.js';

const device = (deviceId: string, name: string) => ({
  sourceId: 'zigbee',
  deviceId,
  name,
  topic: `zigbee2mqtt/${name}`,
  manufacturer: 'SONOFF',
  model: 'ZBMINIL2',
  rulesOnly: false,
  renameable: false,
  endpoints: [''],
  properties: [
    {
      key: 'state',
      label: 'State',
      semantic: 'state',
      type: 'binary',
      category: 'primary',
      endpoint: '',
      readable: true,
      writable: true,
      publishable: true,
      role: 'power',
      onValue: 'ON',
      offValue: 'OFF',
    },
  ],
  exposure: { properties: [] },
  state: {},
  lastSeen: {},
});

const devices = [device('0xa', 'hall_lamp'), device('0xb', 'porch_lamp')];
const ref = (deviceId: string) => ({ sourceId: 'zigbee', deviceId, propertyKey: 'state' });

const rule = (actions: unknown[]) => ({
  id: 'r1',
  name: 'Tell me',
  enabled: true,
  triggers: [{ ...ref('0xa'), match: { kind: 'changedTo', value: 'ON' } }],
  branches: [{ actions }],
});

async function openRule(actions: unknown[], canNotify = true) {
  const ui = await openInterface({ state: { devices, canNotify }, rules: [rule(actions)] });
  await ui.click(ui.byText('button.tab', 'Automation'));
  await ui.openCard(ui.document.querySelector('.rule') as HTMLDetailsElement);
  return ui;
}

const picker = (ui: { document: Document }) =>
  ui.document.querySelector('.actions .device-picker') as HTMLSelectElement;

const options = (ui: { document: Document }) =>
  [...picker(ui).options].map((option) => option.textContent);

describe('sending a notification from the action row', () => {
  it('is offered under the devices once a topic is set, and not before', async () => {
    const withTopic = await openRule([{ ...ref('0xb'), value: 'ON' }]);
    expect(options(withTopic).at(-1)).toBe('Send notification');

    const without = await openRule([{ ...ref('0xb'), value: 'ON' }], false);
    expect(options(without)).not.toContain('Send notification');
  });

  it('keeps one already written listed, whatever the settings say now', async () => {
    const ui = await openRule([{ kind: 'notify', message: 'Hallo' }], false);
    expect(picker(ui).value).toBe('__notify');
  });

  it('turns the row into a title, a delay and a message', async () => {
    const ui = await openRule([{ ...ref('0xb'), value: 'ON' }]);
    const select = picker(ui);
    select.value = '__notify';
    select.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();

    const row = ui.document.querySelector('.actions .rule-row') as HTMLElement;
    const title = row.querySelector('input.notify-title') as HTMLInputElement;
    const message = row.querySelector('textarea.notify-message') as HTMLTextAreaElement;
    expect(title.placeholder).toBe('Title');
    expect(row.querySelector('input.delay')).not.toBeNull();
    // What it may say, shown as an example sentence while it is empty.
    expect(message.placeholder).toBe('<rule>: <trigger> <property> is <value>');
    // And no line underneath explaining it.
    expect(row.querySelector('.placeholders')).toBeNull();
  });

  it('sends what was typed when saved, and reads it back', async () => {
    const ui = await openRule([{ ...ref('0xb'), value: 'ON' }]);
    const select = picker(ui);
    select.value = '__notify';
    select.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();

    const title = ui.document.querySelector('input.notify-title') as HTMLInputElement;
    const message = ui.document.querySelector('textarea.notify-message') as HTMLTextAreaElement;
    title.value = 'Let op';
    title.dispatchEvent(new ui.window.Event('input'));
    message.value = '<trigger> staat aan';
    message.dispatchEvent(new ui.window.Event('input'));
    await ui.settle();
    await ui.click(ui.byText('button.primary', 'Save'));

    const saved = ui.requests.findLast((request) => request.body !== undefined)?.body as {
      branches: { actions: unknown[] }[];
    };
    expect(saved.branches[0]?.actions[0]).toEqual({
      kind: 'notify',
      title: 'Let op',
      message: '<trigger> staat aan',
    });

    const again = await openRule([{ kind: 'notify', title: 'Let op', message: '<trigger> staat aan' }]);
    expect((again.document.querySelector('input.notify-title') as HTMLInputElement).value).toBe(
      'Let op',
    );
    expect(
      (again.document.querySelector('textarea.notify-message') as HTMLTextAreaElement).value,
    ).toBe('<trigger> staat aan');
  });

  it('goes back to a device when one is picked again', async () => {
    const ui = await openRule([{ kind: 'notify', message: 'Hallo' }]);
    const select = picker(ui);
    select.value = 'zigbee|0xb';
    select.dispatchEvent(new ui.window.Event('change'));
    await ui.settle();

    expect(ui.document.querySelector('textarea.notify-message')).toBeNull();
    expect(picker(ui).value).not.toBe('__notify');
  });

  it('says a rule sends a notification in the list', async () => {
    const only = await openInterface({
      state: { devices, canNotify: true },
      rules: [rule([{ kind: 'notify', message: 'Hallo' }])],
    });
    await only.click(only.byText('button.tab', 'Automation'));
    expect(only.document.querySelector('#automation .device-meta')?.textContent).toBe(
      'hall_lamp → notification',
    );

    const both = await openInterface({
      state: { devices, canNotify: true },
      rules: [rule([{ ...ref('0xb'), value: 'ON' }, { kind: 'notify', message: 'Hallo' }])],
    });
    await both.click(both.byText('button.tab', 'Automation'));
    expect(both.document.querySelector('#automation .device-meta')?.textContent).toBe(
      'hall_lamp → porch_lamp + notification',
    );
  });
});
