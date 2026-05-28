import { PrismaClient, ProjectStatus } from '@prisma/client';

import { seedProjects } from '../src/modules/identity/bootstrap/project-seed-data.js';

const prisma = new PrismaClient();

async function seed() {
  for (const projectDefinition of seedProjects) {
    const project = await prisma.project.upsert({
      where: {
        slug: projectDefinition.slug,
      },
      create: {
        slug: projectDefinition.slug,
        name: projectDefinition.name,
        status: ProjectStatus.ACTIVE,
      },
      update: {
        name: projectDefinition.name,
        status: ProjectStatus.ACTIVE,
      },
    });

    for (const roleDefinition of projectDefinition.roles) {
      await prisma.projectRole.upsert({
        where: {
          projectId_code: {
            projectId: project.id,
            code: roleDefinition.code,
          },
        },
        create: {
          projectId: project.id,
          code: roleDefinition.code,
          name: roleDefinition.name,
          description: roleDefinition.description,
        },
        update: {
          name: roleDefinition.name,
          description: roleDefinition.description,
        },
      });
    }
  }
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
