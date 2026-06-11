import { describe, expect, it } from 'vitest';

import { resolveSessionCookieSecure } from './auth.cookies.js';

describe('resolveSessionCookieSecure', () => {
  it('forces secure when sameSite is none, regardless of other inputs', () => {
    expect(resolveSessionCookieSecure('none', false, false)).toBe(true);
    expect(resolveSessionCookieSecure('none', undefined, false)).toBe(true);
  });

  it('honors an explicit override for lax/strict', () => {
    expect(resolveSessionCookieSecure('lax', true, false)).toBe(true);
    expect(resolveSessionCookieSecure('strict', false, true)).toBe(false);
  });

  it('falls back to "secure in production" when no override is given', () => {
    expect(resolveSessionCookieSecure('lax', undefined, true)).toBe(true);
    expect(resolveSessionCookieSecure('lax', undefined, false)).toBe(false);
  });
});
