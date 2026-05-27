import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { z } from 'zod';

const envFilePath = resolve(process.cwd(), '.env');

if (existsSync(envFilePath)) {
  process.loadEnvFile(envFilePath);
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  DATABASE_URL: z.url(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

export const env = envSchema.parse(process.env);
