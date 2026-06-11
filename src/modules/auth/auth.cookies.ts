import type { CookieSerializeOptions } from '@fastify/cookie';

import { env } from '../../config/env.js';

const sessionTtlSeconds = 24 * 60 * 60;

export function getSessionCookieName(): string {
  return env.SESSION_COOKIE_NAME;
}

/**
 * Resolve the cookie `secure` flag. `sameSite=none` is only honored by browsers
 * on secure cookies, so it forces `secure` on; otherwise an explicit override
 * wins, falling back to "secure in production".
 */
export function resolveSessionCookieSecure(
  sameSite: 'lax' | 'strict' | 'none',
  secureOverride: boolean | undefined,
  isProduction: boolean,
): boolean {
  if (sameSite === 'none') {
    return true;
  }
  return secureOverride ?? isProduction;
}

export function getSessionCookieOptions(): CookieSerializeOptions {
  const sameSite = env.COOKIE_SAMESITE;

  return {
    httpOnly: true,
    sameSite,
    path: '/',
    secure: resolveSessionCookieSecure(sameSite, env.COOKIE_SECURE, env.NODE_ENV === 'production'),
    maxAge: sessionTtlSeconds,
  };
}

export function getSessionExpiresAt(referenceDate: Date): Date {
  return new Date(referenceDate.getTime() + sessionTtlSeconds * 1000);
}
