import { describe, expect, it } from 'vitest';
import { parseAddress } from '../src/config.js';
import { silentLogger } from '../src/logger.js';

describe('parseAddress', () => {
  const parse = (address: string) => parseAddress(address, silentLogger);

  it('splits host and port', () => {
    expect(parse('localhost:1883')).toEqual({ host: 'localhost', port: 1883 });
    expect(parse('192.168.1.5:1884')).toEqual({ host: '192.168.1.5', port: 1884 });
    expect(parse('pi.local:8883')).toEqual({ host: 'pi.local', port: 8883 });
  });

  it('keeps the default port when none is given', () => {
    expect(parse('localhost')).toEqual({ host: 'localhost', port: 1883 });
    expect(parse('  pi.local  ')).toEqual({ host: 'pi.local', port: 1883 });
  });

  it('handles IPv6, which is mostly colons', () => {
    // Bracketed, so there is somewhere for a port to go.
    expect(parse('[::1]:1884')).toEqual({ host: '::1', port: 1884 });
    expect(parse('[fe80::1]')).toEqual({ host: 'fe80::1', port: 1883 });
    // Bare, so every colon belongs to the address.
    expect(parse('::1')).toEqual({ host: '::1', port: 1883 });
  });

  it('refuses something that is not an address, rather than guessing', () => {
    expect(parse('localhost:nope')).toBeUndefined();
    expect(parse('localhost:0')).toBeUndefined();
    expect(parse('localhost:99999')).toBeUndefined();
    expect(parse(':1883')).toBeUndefined();
  });

  it('has nothing to say about nothing', () => {
    expect(parse('')).toBeUndefined();
    expect(parse('   ')).toBeUndefined();
  });
});
