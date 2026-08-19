/**
 * HomeKit's rule for a name, as HAP enforces it.
 *
 * A name must begin and end with a letter or number. Spaces, apostrophes and
 * common punctuation are allowed only in between. Anything else, an emoji or a
 * symbol, is rejected outright.
 */
const VALID_NAME = /^[\p{L}\p{N}][\p{L}\p{N}\p{Zs}’'&!._:;()/,-]*[\p{L}\p{N}]$/u;

/** Characters HomeKit tolerates somewhere in a name. */
const ALLOWED_ANYWHERE = /[^\p{L}\p{N}\p{Zs}’'&!._:;()/,-]/gu;

export function isValidName(name: string): boolean {
  // A single letter or number is a legitimate name and the pattern above,
  // needing a first and a last character, cannot express that.
  return /^[\p{L}\p{N}]$/u.test(name) || VALID_NAME.test(name);
}

/**
 * Makes a name HomeKit will accept, changing as little as possible.
 *
 * Device names come from Zigbee2MQTT descriptions and from whatever the user
 * typed, so `Gang Licht (voordeur)` is entirely reasonable and HomeKit refuses
 * it for ending in a bracket. Left alone it warns on every start and can leave
 * the accessory unresponsive, so it is worth correcting rather than reporting.
 */
export function sanitiseName(name: string, fallback: string): string {
  let cleaned = name.replace(ALLOWED_ANYWHERE, ' ');

  // Only the ends are restricted, so trim rather than strip throughout.
  cleaned = cleaned.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '');

  // Trimming a trailing bracket would leave the opening one dangling, which
  // reads worse than dropping the pair.
  if (!balanced(cleaned)) {
    cleaned = cleaned.replace(/[()]/g, ' ');
    cleaned = cleaned.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '');
  }

  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  if (!cleaned || !isValidName(cleaned)) {
    return sanitiseFallback(fallback);
  }
  return cleaned;
}

function balanced(name: string): boolean {
  let depth = 0;
  for (const character of name) {
    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
      if (depth < 0) {
        return false;
      }
    }
  }
  return depth === 0;
}

/** Last resort, when a name survives none of the above. */
function sanitiseFallback(fallback: string): string {
  const cleaned = fallback
    .replace(ALLOWED_ANYWHERE, ' ')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned && isValidName(cleaned) ? cleaned : 'Device';
}
