import { describe, expect, it } from 'vitest';

import { joinTopic, topicMatches } from '../src/mqtt/topics.js';

describe('topicMatches', () => {
  it('matches exact topics', () => {
    expect(topicMatches('a/b/c', 'a/b/c')).toBe(true);
    expect(topicMatches('a/b/c', 'a/b/d')).toBe(false);
  });

  it('matches a single level with +', () => {
    expect(topicMatches('a/+/c', 'a/b/c')).toBe(true);
    expect(topicMatches('a/+/c', 'a/b/d/c')).toBe(false);
    expect(topicMatches('a/+', 'a/b')).toBe(true);
    expect(topicMatches('a/+', 'a/b/c')).toBe(false);
  });

  it('matches the remainder with #', () => {
    expect(topicMatches('a/#', 'a/b')).toBe(true);
    expect(topicMatches('a/#', 'a/b/c/d')).toBe(true);
    expect(topicMatches('#', 'a/b')).toBe(true);
  });

  it('does not match more levels than the filter has', () => {
    expect(topicMatches('a/b', 'a/b/c')).toBe(false);
    expect(topicMatches('a/b/c', 'a/b')).toBe(false);
  });

  it('keeps wildcards away from $ topics', () => {
    expect(topicMatches('#', '$SYS/broker/uptime')).toBe(false);
    expect(topicMatches('+/broker/uptime', '$SYS/broker/uptime')).toBe(false);
    expect(topicMatches('$SYS/#', '$SYS/broker/uptime')).toBe(true);
  });
});

describe('joinTopic', () => {
  it('joins levels and drops empty segments', () => {
    expect(joinTopic('zigbee2mqtt', 'device')).toBe('zigbee2mqtt/device');
    expect(joinTopic('zigbee2mqtt/', '/device')).toBe('zigbee2mqtt/device');
    expect(joinTopic('zigbee2mqtt', 'bridge', 'devices')).toBe('zigbee2mqtt/bridge/devices');
    expect(joinTopic('a', '', 'b')).toBe('a/b');
  });
});
