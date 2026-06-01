import type { FastifyRequest } from 'fastify';

import type { PrismaClient } from '../../shared/db/prisma-types.js';

import {
  getServicePrincipalTokenFromHeader,
  requireAuthenticatedServicePrincipal,
} from '../../shared/auth/service-principal-auth.js';
import { AppError } from '../../shared/errors/app-error.js';

interface AdminGuardDbClient {
  servicePrincipal: PrismaClient['servicePrincipal'];
  project: PrismaClient['project'];
}

export interface AdminTargetProject {
  id: string;
  slug: string;
  name: string;
  status: 'ACTIVE' | 'DISABLED';
}

export async function requireServicePrincipalFromRequest(
  prisma: AdminGuardDbClient,
  request: FastifyRequest,
) {
  const authorizationHeader = request.headers.authorization;
  const token = getServicePrincipalTokenFromHeader(authorizationHeader);

  return requireAuthenticatedServicePrincipal(prisma, token);
}

/**
 * Resolves the envelope `targetProjectId` to a usable project. A missing or
 * disabled project is a hard error; the service-principal allow-list check is
 * intentionally left to the caller so a forbidden target can be recorded as a
 * `denied` operation rather than an HTTP error.
 */
export async function requireTargetProjectById(
  prisma: AdminGuardDbClient,
  targetProjectId: string,
): Promise<AdminTargetProject> {
  const project = await prisma.project.findUnique({
    where: {
      id: targetProjectId,
    },
    select: {
      id: true,
      slug: true,
      name: true,
      status: true,
    },
  });

  if (project === null) {
    throw new AppError('Project not found', {
      statusCode: 404,
      code: 'PROJECT_NOT_FOUND',
    });
  }

  if (project.status === 'DISABLED') {
    throw new AppError('Project is disabled', {
      statusCode: 403,
      code: 'PROJECT_DISABLED',
    });
  }

  return project;
}

export function getCorrelationIdFromRequest(request: FastifyRequest): string | undefined {
  const header = request.headers['x-correlation-id'];

  if (Array.isArray(header)) {
    return header[0];
  }

  return header ?? undefined;
}
