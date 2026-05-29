import { upsertProjectSeedData } from '../src/modules/identity/bootstrap/project-seed.js';
import { createPrismaClient } from '../src/shared/db/prisma-client.js';

const prisma = createPrismaClient();

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
