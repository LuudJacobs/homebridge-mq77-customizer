import { describe, expect, it } from 'vitest';

import { sanitiseName } from '../src/homekit/names.js';

/**
 * Copied verbatim from HAP-NodeJS `checkName`, so these tests measure against
 * what actually warns rather than against our reading of it.
 */
const HAP_NAME = /^[\p{L}\p{N}][\p{L}\p{N}\p{Zs}’'&!._:;()/,-]*[\p{L}\p{N}]$/u;

const accepted = (name: string) => HAP_NAME.test(name) || /^[\p{L}\p{N}]$/u.test(name);

describe('sanitiseName', () => {
  it('leaves a name HomeKit already accepts alone', () => {
    for (const name of [
      'Woonkamer',
      'Gang licht 1',
      "Anna's lamp",
      'Keuken (bar) aanrecht',
      'Lamp 2',
      'A',
    ]) {
      expect(sanitiseName(name, 'fallback')).toBe(name);
    }
  });

  it('fixes a name that ends in a bracket, which is what Zigbee2MQTT descriptions do', () => {
    // Trimming the closing bracket alone would leave the opening one dangling.
    expect(sanitiseName('Gang Licht (voordeur)', '0xabc')).toBe('Gang Licht voordeur');
    expect(sanitiseName('Gang Licht (kantoor)', '0xabc')).toBe('Gang Licht kantoor');
  });

  it('trims what may not sit at either end', () => {
    expect(sanitiseName('  Woonkamer  ', 'x')).toBe('Woonkamer');
    expect(sanitiseName('-Woonkamer-', 'x')).toBe('Woonkamer');
    expect(sanitiseName('...Lamp!!!', 'x')).toBe('Lamp');
  });

  it('drops characters HomeKit will not take anywhere', () => {
    expect(sanitiseName('💡 Keuken', 'x')).toBe('Keuken');
    expect(sanitiseName('Lamp ★ 2', 'x')).toBe('Lamp 2');
    expect(sanitiseName('Küche #1', 'x')).toBe('Küche 1');
  });

  it('keeps punctuation that is allowed in the middle', () => {
    expect(sanitiseName('Hal, boven', 'x')).toBe('Hal, boven');
    expect(sanitiseName('Lamp 1/2', 'x')).toBe('Lamp 1/2');
    expect(sanitiseName('Bad & douche', 'x')).toBe('Bad & douche');
  });

  it('falls back when nothing usable is left', () => {
    expect(sanitiseName('...', '0x00158dfffe000002')).toBe('0x00158dfffe000002');
    expect(sanitiseName('', '💡')).toBe('Device');
  });

  it('always produces something HomeKit accepts', () => {
    const awkward = [
      'Gang Licht (voordeur)',
      '💡',
      '   ',
      '(((',
      'a)',
      '(a',
      '-',
      '1',
      'Ünïcödé nàme',
      'ends with apostrophe’',
      'Lamp\n2',
      'tab\there',
      '🙂 🙃',
      'x'.repeat(200),
    ];
    for (const name of awkward) {
      const cleaned = sanitiseName(name, 'Device');
      expect(accepted(cleaned), `${JSON.stringify(name)} became ${JSON.stringify(cleaned)}`).toBe(
        true,
      );
    }
  });
});
