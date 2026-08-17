import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'mq77customizer';
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Stateless signed session cookies.
 *
 * The cookie carries its own expiry and a signature over it, so nothing has to
 * be tracked server side and logins survive a Homebridge restart. The secret
 * lives in the store rather than being regenerated each run.
 */
export class Sessions {
  constructor(
    private readonly secret: string,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  issue(now = Date.now()): string {
    const expiry = String(now + this.ttlMs);
    return `${expiry}.${this.sign(expiry)}`;
  }

  verify(value: string | undefined, now = Date.now()): boolean {
    if (!value) {
      return false;
    }
    const separator = value.lastIndexOf('.');
    if (separator <= 0) {
      return false;
    }
    const expiry = value.slice(0, separator);
    const signature = value.slice(separator + 1);

    if (!equals(signature, this.sign(expiry))) {
      return false;
    }
    const expiresAt = Number(expiry);
    return Number.isFinite(expiresAt) && expiresAt > now;
  }

  cookieHeader(value: string): string {
    const maxAge = Math.floor(this.ttlMs / 1000);
    // No Secure flag: this is plain HTTP on a home network, and setting it
    // would stop the cookie being stored at all.
    return `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
  }

  clearHeader(): string {
    return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('hex');
  }
}

export function readCookie(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE_NAME) {
      return rest.join('=');
    }
  }
  return undefined;
}

/** Constant time comparison that tolerates differing lengths. */
export function equals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    // Still compare something of equal length so the timing does not leak
    // whether the length matched.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}
