import { writeFileSync } from 'node:fs';

import {
  DEFAULT_RETENTION_DAYS,
  pruneAdminOperations,
} from '../src/modules/admin-operations/admin-operations.retention.js';
import { createPrismaClient } from '../src/shared/db/prisma-client.js';

const prisma = createPrismaClient();

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const result = await pruneAdminOperations(prisma, {
    retentionDays: args.retentionDays,
    dryRun: args.dryRun,
    includeExport: args.exportPath !== null,
  });

  if (args.exportPath !== null && result.exported !== null) {
    writeFileSync(args.exportPath, `${JSON.stringify(result.exported, null, 2)}\n`, 'utf8');
    console.log(`Exported ${result.exported.length} operation(s) to ${args.exportPath}`);
  }

  const mode = result.dryRun ? 'dry run (no rows deleted)' : 'pruned';
  console.log(
    `Admin operations retention ${mode}: retentionDays=${result.retentionDays}, cutoff=${result.cutoff}, candidates=${result.candidateCount}, deleted=${result.deletedCount}`,
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error: unknown) => {
    console.error('Failed to prune admin operations', error);
    await prisma.$disconnect();
    process.exit(1);
  });

function parseArgs(argv: string[]) {
  let retentionDays = DEFAULT_RETENTION_DAYS;
  let dryRun = false;
  let exportPath: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--older-than-days') {
      const value = argv[index + 1];
      if (value !== undefined) {
        retentionDays = Number.parseInt(value, 10);
      }
      index += 1;
      continue;
    }

    if (argument === '--export') {
      exportPath = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (argument === '--dry-run') {
      dryRun = true;
    }
  }

  return {
    retentionDays,
    dryRun,
    exportPath,
  };
}
