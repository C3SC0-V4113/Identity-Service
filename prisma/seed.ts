import { PrismaClient } from '@prisma/client';

import { upsertProjectSeedData } from '../src/modules/identity/bootstrap/project-seed.js';

const prisma = new PrismaClient();

async function seed() {
  await upsertProjectSeedData(prisma);
}

seed()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error: unknown) => {
    console.error('Failed to seed identity-service bootstrap data', error);
    await prisma.$disconnect();
    process.exit(1);
  });
