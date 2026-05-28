import type { CookieSerializeOptions } from '@fastify/cookie';

import { env } from '../../config/env.js';

const sessionTtlSeconds = 24 * 60 * 60;

export function getSessionCookieName(): string {
  return env.SESSION_COOKIE_NAME;
}

export function getSessionCookieOptions(): CookieSerializeOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: env.NODE_ENV === 'production',
    maxAge: sessionTtlSeconds,
  };
}

export function getSessionExpiresAt(referenceDate: Date): Date {
  return new Date(referenceDate.getTime() + sessionTtlSeconds * 1000);
}
