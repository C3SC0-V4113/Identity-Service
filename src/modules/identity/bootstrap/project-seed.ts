import type { Prisma, PrismaClient } from '@prisma/client';
import { ProjectStatus } from '@prisma/client';

import { seedProjects } from './project-seed-data.js';

type PrismaDbClient = PrismaClient | Prisma.TransactionClient;

export async function upsertProjectSeedData(prisma: PrismaDbClient): Promise<void> {
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
