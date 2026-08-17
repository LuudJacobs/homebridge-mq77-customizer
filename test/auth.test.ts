import { describe, expect, it } from 'vitest';

import { equals, readCookie, Sessions } from '../src/web/auth.js';

describe('Sessions', () => {
  const sessions = new Sessions('a-secret', 1000);

  it('accepts a cookie it issued', () => {
    expect(sessions.verify(sessions.issue())).toBe(true);
  });

  it('rejects a cookie signed with a different secret', () => {
    const other = new Sessions('another-secret', 1000);
    expect(sessions.verify(other.issue())).toBe(false);
  });

  it('rejects a tampered expiry', () => {
    const issued = sessions.issue(0);
    const signature = issued.slice(issued.lastIndexOf('.') + 1);
    expect(sessions.verify(`99999999999999.${signature}`)).toBe(false);
  });

  it('rejects an expired cookie', () => {
    const issued = sessions.issue(0);
    expect(sessions.verify(issued, 500)).toBe(true);
    expect(sessions.verify(issued, 1500)).toBe(false);
  });

  it('rejects nonsense', () => {
    expect(sessions.verify(undefined)).toBe(false);
    expect(sessions.verify('')).toBe(false);
    expect(sessions.verify('nodot')).toBe(false);
    expect(sessions.verify('.onlysignature')).toBe(false);
  });

  it('sets a cookie that javascript cannot read', () => {
    const header = sessions.cookieHeader('value');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
  });

  it('clears with a zero max age', () => {
    expect(sessions.clearHeader()).toContain('Max-Age=0');
  });
});

describe('readCookie', () => {
  it('finds our cookie among others', () => {
    expect(readCookie('other=1; mqttcustomizer=abc.def; another=2')).toBe('abc.def');
  });

  it('returns undefined when absent', () => {
    expect(readCookie('other=1')).toBeUndefined();
    expect(readCookie(undefined)).toBeUndefined();
  });
});

describe('equals', () => {
  it('compares without throwing on different lengths', () => {
    expect(equals('abc', 'abc')).toBe(true);
    expect(equals('abc', 'abd')).toBe(false);
    expect(equals('abc', 'abcdef')).toBe(false);
    expect(equals('', '')).toBe(true);
  });
});
