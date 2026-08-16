/** MQTT topic filter matching, per the `+` and `#` wildcard rules. */

export function topicMatches(filter: string, topic: string): boolean {
  const filterParts = filter.split('/');
  const topicParts = topic.split('/');

  for (let i = 0; i < filterParts.length; i++) {
    const f = filterParts[i];

    if (f === '#') {
      // `#` must be the last level, and matches the rest including nothing.
      // It does not match a topic starting with `$` at the first level.
      return i !== 0 || !topicParts[0]?.startsWith('$');
    }

    if (i >= topicParts.length) {
      return false;
    }

    if (f === '+') {
      if (i === 0 && topicParts[0]?.startsWith('$')) {
        return false;
      }
      continue;
    }

    if (f !== topicParts[i]) {
      return false;
    }
  }

  return filterParts.length === topicParts.length;
}

/** Joins topic levels, dropping empty segments so callers need not trim slashes. */
export function joinTopic(...parts: string[]): string {
  return parts
    .flatMap((part) => part.split('/'))
    .filter((part) => part.length > 0)
    .join('/');
}
