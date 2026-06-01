import type { PrismaClient } from '../../../shared/db/prisma-types.js';

import {
  generateServicePrincipalToken,
  hashServicePrincipalToken,
} from '../../../shared/auth/service-principal-auth.js';
import { AppError } from '../../../shared/errors/app-error.js';

export interface BootstrapServicePrincipalInput {
  slug: string;
  name: string;
  description?: string | null;
  allProjects?: boolean;
  projectSlugs?: readonly string[];
}

export interface BootstrapServicePrincipalResult {
  token: string;
  servicePrincipal: {
    id: string;
    slug: string;
    name: string;
    status: 'ACTIVE' | 'DISABLED';
    allProjects: boolean;
    scopedProjectSlugs: string[];
  };
}

/**
 * Creates or rotates a service principal used by the machine-to-machine admin
 * surface (ADR 0008). The plaintext token is only returned here, never persisted;
 * only its SHA256 hash is stored. Re-running for an existing slug rotates the
 * secret and re-syncs the project allow-list.
 */
export async function bootstrapServicePrincipal(
  prisma: PrismaClient,
  input: BootstrapServicePrincipalInput,
): Promise<BootstrapServicePrincipalResult> {
  const slug = input.slug.trim();
  const name = input.name.trim();
  const allProjects = input.allProjects ?? false;

  if (slug === '') {
    throw new AppError('Service principal slug is required', {
      statusCode: 400,
      code: 'BOOTSTRAP_SERVICE_PRINCIPAL_SLUG_REQUIRED',
    });
  }

  if (name === '') {
    throw new AppError('Service principal name is required', {
      statusCode: 400,
      code: 'BOOTSTRAP_SERVICE_PRINCIPAL_NAME_REQUIRED',
    });
  }

  const requestedProjectSlugs = allProjects
    ? []
    : [...new Set((input.projectSlugs ?? []).map((value) => value.trim()).filter(Boolean))];

  const projects =
    requestedProjectSlugs.length === 0
      ? []
      : await prisma.project.findMany({
          where: {
            slug: {
              in: requestedProjectSlugs,
            },
          },
          select: {
            id: true,
            slug: true,
          },
        });

  if (projects.length !== requestedProjectSlugs.length) {
    const foundSlugs = new Set(projects.map((project: { slug: string }) => project.slug));
    const missingSlugs = requestedProjectSlugs.filter((value) => !foundSlugs.has(value));

    throw new AppError(
      `Project not found for service principal scope: ${missingSlugs.join(', ')}`,
      {
        statusCode: 404,
        code: 'BOOTSTRAP_SERVICE_PRINCIPAL_PROJECT_NOT_FOUND',
      },
    );
  }

  const token = generateServicePrincipalToken();
  const secretHash = hashServicePrincipalToken(token);
  const scopedProjectIds = projects.map((project: { id: string }) => project.id);

  const servicePrincipal = await prisma.$transaction(async (transactionClient: unknown) => {
    const tx = transactionClient as unknown as {
      servicePrincipal: PrismaClient['servicePrincipal'];
      servicePrincipalProjectScope: PrismaClient['servicePrincipalProjectScope'];
    };

    const principal = await tx.servicePrincipal.upsert({
      where: {
        slug,
      },
      create: {
        slug,
        name,
        description: input.description ?? null,
        status: 'ACTIVE',
        secretHash,
        allProjects,
      },
      update: {
        name,
        description: input.description ?? null,
        status: 'ACTIVE',
        secretHash,
        allProjects,
      },
      select: {
        id: true,
        slug: true,
        name: true,
        status: true,
        allProjects: true,
      },
    });

    await tx.servicePrincipalProjectScope.deleteMany({
      where: {
        servicePrincipalId: principal.id,
      },
    });

    if (scopedProjectIds.length > 0) {
      await tx.servicePrincipalProjectScope.createMany({
        data: scopedProjectIds.map((projectId) => ({
          servicePrincipalId: principal.id,
          projectId,
        })),
      });
    }

    return principal;
  });

  return {
    token,
    servicePrincipal: {
      id: servicePrincipal.id,
      slug: servicePrincipal.slug,
      name: servicePrincipal.name,
      status: servicePrincipal.status,
      allProjects: servicePrincipal.allProjects,
      scopedProjectSlugs: projects.map((project: { slug: string }) => project.slug),
    },
  };
}
