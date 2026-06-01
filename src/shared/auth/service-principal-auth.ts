import { createHash, randomBytes } from 'node:crypto';

import type { PrismaClient } from '../db/prisma-types.js';

import { AppError } from '../errors/app-error.js';

const servicePrincipalTokenBytes = 32;

interface ServicePrincipalAuthDbClient {
  servicePrincipal: PrismaClient['servicePrincipal'];
}

export interface AuthenticatedServicePrincipal {
  id: string;
  slug: string;
  name: string;
  status: 'ACTIVE' | 'DISABLED';
  allProjects: boolean;
  scopedProjectIds: readonly string[];
}

export function generateServicePrincipalToken(): string {
  return randomBytes(servicePrincipalTokenBytes).toString('base64url');
}

export function hashServicePrincipalToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function getServicePrincipalTokenFromHeader(
  authorizationHeader: string | undefined,
): string | null {
  if (authorizationHeader === undefined) {
    return null;
  }

  const [scheme, ...rest] = authorizationHeader.trim().split(/\s+/u);

  if (scheme?.toLowerCase() !== 'bearer') {
    return null;
  }

  const token = rest.join(' ').trim();

  return token === '' ? null : token;
}

export async function requireAuthenticatedServicePrincipal(
  prisma: ServicePrincipalAuthDbClient,
  token: string | null,
): Promise<AuthenticatedServicePrincipal> {
  if (token === null) {
    throw servicePrincipalAuthRequiredError();
  }

  const secretHash = hashServicePrincipalToken(token);
  const principal = await prisma.servicePrincipal.findUnique({
    where: {
      secretHash,
    },
    select: {
      id: true,
      slug: true,
      name: true,
      status: true,
      allProjects: true,
      projectScopes: {
        select: {
          projectId: true,
        },
      },
    },
  });

  if (principal === null) {
    throw servicePrincipalAuthRequiredError();
  }

  if (principal.status === 'DISABLED') {
    throw servicePrincipalDisabledError();
  }

  await prisma.servicePrincipal.update({
    where: {
      id: principal.id,
    },
    data: {
      lastUsedAt: new Date(),
    },
  });

  return {
    id: principal.id,
    slug: principal.slug,
    name: principal.name,
    status: principal.status,
    allProjects: principal.allProjects,
    scopedProjectIds: principal.projectScopes.map(
      (scope: { projectId: string }) => scope.projectId,
    ),
  };
}

export function servicePrincipalCanAccessProject(
  principal: Pick<AuthenticatedServicePrincipal, 'allProjects' | 'scopedProjectIds'>,
  targetProjectId: string,
): boolean {
  return principal.allProjects || principal.scopedProjectIds.includes(targetProjectId);
}

export function assertServicePrincipalProjectAccess(
  principal: Pick<AuthenticatedServicePrincipal, 'allProjects' | 'scopedProjectIds'>,
  targetProjectId: string,
): void {
  if (!servicePrincipalCanAccessProject(principal, targetProjectId)) {
    throw servicePrincipalProjectForbiddenError();
  }
}

function servicePrincipalAuthRequiredError(): AppError {
  return new AppError('Service principal authentication required', {
    statusCode: 401,
    code: 'SERVICE_PRINCIPAL_AUTH_REQUIRED',
  });
}

function servicePrincipalDisabledError(): AppError {
  return new AppError('Service principal is disabled', {
    statusCode: 403,
    code: 'SERVICE_PRINCIPAL_DISABLED',
  });
}

function servicePrincipalProjectForbiddenError(): AppError {
  return new AppError('Service principal is not allowed to target this project', {
    statusCode: 403,
    code: 'SERVICE_PRINCIPAL_PROJECT_FORBIDDEN',
  });
}
