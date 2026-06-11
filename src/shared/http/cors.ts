/**
 * Resolve the `@fastify/cors` `origin` option from the `CORS_ORIGIN` env value:
 * - unset/empty -> `false` (CORS disabled; same-site / BFF default)
 * - `*`         -> `true` (reflect the request origin)
 * - otherwise   -> the comma-separated list of explicit allowed origins
 */
export function parseCorsOrigin(rawOrigin: string | undefined): boolean | string[] {
  const raw = rawOrigin?.trim();
  if (!raw) {
    return false;
  }
  if (raw === '*') {
    return true;
  }
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
