import type { PrismaClient } from '../../../shared/db/prisma-types.js';

import { normalizeEmail } from '../../../shared/auth/email.js';
import { AppError } from '../../../shared/errors/app-error.js';

export interface BootstrapProjectAdminMembershipsInput {
  email: string;
  projectSlugs: readonly string[];
}

export async function bootstrapProjectAdminMemberships(
  prisma: PrismaClient,
  input: BootstrapProjectAdminMembershipsInput,
) {
  const emailNormalized = normalizeEmail(input.email);
  const projectSlugs = [...new Set(input.projectSlugs.map((slug) => slug.trim()).filter(Boolean))];

  if (projectSlugs.length === 0) {
    throw new AppError('At least one project slug is required', {
      statusCode: 400,
      code: 'BOOTSTRAP_PROJECTS_REQUIRED',
    });
  }

  const user = await prisma.user.findUnique({
    where: {
      emailNormalized,
    },
    select: {
      id: true,
      email: true,
      displayName: true,
    },
  });

  if (user === null) {
    throw new AppError('User not found for admin bootstrap', {
      statusCode: 404,
      code: 'BOOTSTRAP_ADMIN_USER_NOT_FOUND',
    });
  }

  const projects = await prisma.project.findMany({
    where: {
      slug: {
        in: projectSlugs,
      },
    },
    select: {
      id: true,
      slug: true,
      name: true,
      roles: {
        where: {
          code: 'admin',
        },
        select: {
          id: true,
          code: true,
          name: true,
        },
      },
    },
  });

  if (projects.length !== projectSlugs.length) {
    const foundProjectSlugs = new Set(
      projects.map((project: (typeof projects)[number]) => project.slug),
    );
    const missingProjectSlugs = projectSlugs.filter((slug) => !foundProjectSlugs.has(slug));

    throw new AppError(`Project not found for admin bootstrap: ${missingProjectSlugs.join(', ')}`, {
      statusCode: 404,
      code: 'BOOTSTRAP_PROJECT_NOT_FOUND',
    });
  }

  for (const project of projects) {
    if (project.roles.length !== 1) {
      throw new AppError(`Admin role not found for project ${project.slug}`, {
        statusCode: 400,
        code: 'BOOTSTRAP_PROJECT_ADMIN_ROLE_NOT_FOUND',
      });
    }
  }

  return prisma.$transaction(async (transactionClient: unknown) => {
    const tx = transactionClient as unknown as {
      projectMembership: PrismaClient['projectMembership'];
      projectMembershipRole: PrismaClient['projectMembershipRole'];
    };
    const memberships: Array<{
      id: string;
      status: 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
      project: {
        id: string;
        slug: string;
        name: string;
      };
      membershipRoles: Array<{
        role: {
          id: string;
          code: string;
          name: string;
        };
      }>;
    }> = [];

    for (const projectSlug of projectSlugs) {
      const project = projects.find(
        (candidate: (typeof projects)[number]) => candidate.slug === projectSlug,
      );

      if (project === undefined) {
        throw new AppError(`Project not found for admin bootstrap: ${projectSlug}`, {
          statusCode: 404,
          code: 'BOOTSTRAP_PROJECT_NOT_FOUND',
        });
      }

      const adminRole = project.roles[0];

      if (adminRole === undefined) {
        throw new AppError(`Admin role not found for project ${project.slug}`, {
          statusCode: 400,
          code: 'BOOTSTRAP_PROJECT_ADMIN_ROLE_NOT_FOUND',
        });
      }
      const membership = await tx.projectMembership.upsert({
        where: {
          projectId_userId: {
            projectId: project.id,
            userId: user.id,
          },
        },
        create: {
          projectId: project.id,
          userId: user.id,
          status: 'ACTIVE',
        },
        update: {
          status: 'ACTIVE',
        },
        select: {
          id: true,
          status: true,
        },
      });

      await tx.projectMembershipRole.upsert({
        where: {
          membershipId_roleId: {
            membershipId: membership.id,
            roleId: adminRole.id,
          },
        },
        create: {
          membershipId: membership.id,
          roleId: adminRole.id,
        },
        update: {},
      });

      const fullMembership = await tx.projectMembership.findUniqueOrThrow({
        where: {
          id: membership.id,
        },
        select: {
          id: true,
          status: true,
          project: {
            select: {
              id: true,
              slug: true,
              name: true,
            },
          },
          membershipRoles: {
            orderBy: {
              role: {
                code: 'asc',
              },
            },
            select: {
              role: {
                select: {
                  id: true,
                  code: true,
                  name: true,
                },
              },
            },
          },
        },
      });

      memberships.push(fullMembership);
    }

    return {
      user,
      memberships,
    };
  });
}
