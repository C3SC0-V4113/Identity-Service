import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig, env } from 'prisma/config';

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

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
});
