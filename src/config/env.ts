import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { z } from 'zod';

const envFilePath = resolve(process.cwd(), '.env');

if (existsSync(envFilePath)) {
  const envFileContents = readFileSync(envFilePath, 'utf8');

  for (const line of envFileContents.split(/\r?\n/u)) {
    const trimmedLine = line.trim();

    if (trimmedLine === '' || trimmedLine.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmedLine.indexOf('=');

    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    const value = trimmedLine.slice(separatorIndex + 1).trim();

    process.env[key] = value;
  }
}

/** Parse an env string into a boolean, accepting only `'true'` / `'false'`. */
const envBoolean = z.enum(['true', 'false']).transform((value) => value === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  DATABASE_URL: z.url(),
  SESSION_COOKIE_NAME: z.string().min(1).default('identity_service_session'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Cross-origin allow-list for the browser surface. Unset/empty keeps CORS
  // disabled (same-site / BFF default). Use `*` to reflect any origin, or a
  // comma-separated list of explicit origins (recommended with credentials).
  CORS_ORIGIN: z.string().optional(),
  // Whether CORS responses allow credentials (cookies). Only relevant when
  // CORS_ORIGIN is set; defaults on so the session cookie flows cross-origin.
  CORS_CREDENTIALS: envBoolean.default(true),
  // Session cookie SameSite. `none` is required for genuine cross-site use and
  // forces `secure`. Defaults to `lax` (same-site).
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  // Override the `secure` cookie flag. When unset it follows
  // `NODE_ENV === 'production'`; `sameSite=none` always forces it on.
  COOKIE_SECURE: envBoolean.optional(),
});

export type Env = z.infer<typeof envSchema>;

export const env = envSchema.parse(process.env);
