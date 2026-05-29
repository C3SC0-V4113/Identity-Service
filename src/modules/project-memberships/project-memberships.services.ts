import type { PrismaClient } from '../../shared/db/prisma-types.js';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';

import { normalizeEmail } from '../../shared/auth/email.js';
import { AppError } from '../../shared/errors/app-error.js';
import { requireProjectAdmin, requireProjectBySlug } from './project-memberships.guards.js';
import {
  createMembershipWithRoles,
  findMembershipByProjectAndUser,
  findMembershipWithRolesByProjectAndUser,
  findProjectRolesByCodes,
  findUserByEmailNormalized,
  listMembershipsByProject,
  replaceMembershipRoles,
} from './project-memberships.repositories.js';
import type {
  CreateProjectMembershipRequest,
  ListProjectMembershipsQuery,
  ProjectAccessResponse,
  ProjectMembershipListResponse,
  ProjectMembershipResponse,
  ReplaceProjectMembershipRolesRequest,
} from './project-memberships.schemas.js';

type PrismaDbClient = Parameters<typeof findProjectRolesByCodes>[0];

const membershipListCursorSchema = {
  parse(cursor: string) {
    try {
      const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
      const parsed = JSON.parse(decoded) as {
        createdAt?: unknown;
        id?: unknown;
      };

      if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') {
        throw new Error('Invalid cursor payload');
      }

      const createdAt = new Date(parsed.createdAt);

      if (Number.isNaN(createdAt.getTime()) || parsed.id.trim().length === 0) {
        throw new Error('Invalid cursor payload');
      }

      return {
        createdAt,
        id: parsed.id,
      };
    } catch {
      throw new AppError('Invalid pagination cursor', {
        statusCode: 400,
        code: 'PROJECT_MEMBERSHIP_CURSOR_INVALID',
      });
    }
  },
};

export async function getProjectAccess(
  prisma: PrismaClient,
  input: {
    projectSlug: string;
    userId: string;
  },
): Promise<ProjectAccessResponse> {
  const project = await requireProjectBySlug(prisma, input.projectSlug);
  const membership = await findMembershipWithRolesByProjectAndUser(
    prisma,
    project.id,
    input.userId,
  );

  if (membership === null) {
    return {
      project,
      access: {
        isMember: false,
        membershipId: null,
        status: null,
        roles: [],
        isAdmin: false,
      },
    };
  }

  const roles = membership.membershipRoles.map(
    (membershipRole: (typeof membership.membershipRoles)[number]) => membershipRole.role,
  );

  return {
    project,
    access: {
      isMember: true,
      membershipId: membership.id,
      status: membership.status,
      roles,
      isAdmin:
        membership.status === 'ACTIVE' &&
        roles.some((role: (typeof roles)[number]) => role.code === 'admin'),
    },
  };
}

export async function createProjectMembership(
  prisma: PrismaClient,
  input: {
    actorUserId: string;
    projectSlug: string;
    body: CreateProjectMembershipRequest;
  },
): Promise<ProjectMembershipResponse> {
  const project = await requireProjectBySlug(prisma, input.projectSlug);
  await requireProjectAdmin(prisma, project.id, input.actorUserId);

  const user = await findUserByEmailNormalized(prisma, normalizeEmail(input.body.email));

  if (user === null) {
    throw new AppError('User not found', {
      statusCode: 404,
      code: 'USER_NOT_FOUND',
    });
  }

  const existingMembership = await findMembershipByProjectAndUser(prisma, project.id, user.id);

  if (existingMembership !== null) {
    throw new AppError('Project membership already exists', {
      statusCode: 409,
      code: 'PROJECT_MEMBERSHIP_ALREADY_EXISTS',
    });
  }

  const roles = await resolveProjectRolesOrThrow(prisma, project.id, input.body.roleCodes);

  try {
    const membership = await createMembershipWithRoles(prisma, {
      projectId: project.id,
      userId: user.id,
      roleIds: roles.map((role: (typeof roles)[number]) => role.id),
    });

    return mapProjectMembershipResponse(membership);
  } catch (error: unknown) {
    if (isMembershipConflictError(error)) {
      throw new AppError('Project membership already exists', {
        statusCode: 409,
        code: 'PROJECT_MEMBERSHIP_ALREADY_EXISTS',
      });
    }

    throw error;
  }
}

export async function listProjectMemberships(
  prisma: PrismaClient,
  input: {
    actorUserId: string;
    projectSlug: string;
    query: ListProjectMembershipsQuery;
  },
): Promise<ProjectMembershipListResponse> {
  const project = await requireProjectBySlug(prisma, input.projectSlug);
  await requireProjectAdmin(prisma, project.id, input.actorUserId);

  const queryText = input.query.q?.trim();
  const records = await listMembershipsByProject(prisma, {
    projectId: project.id,
    limit: input.query.limit + 1,
    status: input.query.status,
    query:
      queryText === undefined
        ? undefined
        : {
            emailNormalized: queryText.toLowerCase(),
            displayName: queryText,
          },
    cursor:
      input.query.cursor === undefined
        ? undefined
        : membershipListCursorSchema.parse(input.query.cursor),
  });

  const hasMore = records.length > input.query.limit;
  const pageItems = hasMore ? records.slice(0, input.query.limit) : records;
  const lastItem = pageItems.at(-1);

  return {
    project,
    items: pageItems.map((membership) => ({
      membershipId: membership.id,
      user: membership.user,
      status: membership.status,
      roles: membership.membershipRoles.map((membershipRole) => membershipRole.role),
      createdAt: membership.createdAt.toISOString(),
      updatedAt: membership.updatedAt.toISOString(),
    })),
    page: {
      nextCursor:
        hasMore && lastItem !== undefined
          ? encodeMembershipListCursor(lastItem.createdAt, lastItem.id)
          : null,
      hasMore,
      limit: input.query.limit,
    },
  };
}

export async function replaceProjectMembershipRoles(
  prisma: PrismaClient,
  input: {
    actorUserId: string;
    projectSlug: string;
    targetUserId: string;
    body: ReplaceProjectMembershipRolesRequest;
  },
): Promise<ProjectMembershipResponse> {
  const project = await requireProjectBySlug(prisma, input.projectSlug);
  await requireProjectAdmin(prisma, project.id, input.actorUserId);

  const membership = await findMembershipByProjectAndUser(prisma, project.id, input.targetUserId);

  if (membership === null) {
    throw new AppError('Project membership not found', {
      statusCode: 404,
      code: 'PROJECT_MEMBERSHIP_NOT_FOUND',
    });
  }

  const updatedMembership = await prisma.$transaction(async (transactionClient: unknown) => {
    const tx = transactionClient as unknown as PrismaDbClient;
    const roles = await resolveProjectRolesOrThrow(tx, project.id, input.body.roleCodes);

    return replaceMembershipRoles(tx, {
      membershipId: membership.id,
      roleIds: roles.map((role: (typeof roles)[number]) => role.id),
    });
  });

  return mapProjectMembershipResponse(updatedMembership);
}

async function resolveProjectRolesOrThrow(
  prisma: PrismaDbClient,
  projectId: string,
  roleCodes: readonly string[],
) {
  const uniqueRoleCodes = [...new Set(roleCodes)];

  if (uniqueRoleCodes.length === 0) {
    throw new AppError('At least one project role is required', {
      statusCode: 400,
      code: 'PROJECT_ROLE_CODES_REQUIRED',
    });
  }

  const roles = await findProjectRolesByCodes(prisma, projectId, uniqueRoleCodes);

  if (roles.length !== uniqueRoleCodes.length) {
    throw new AppError('One or more project roles do not exist in this project', {
      statusCode: 400,
      code: 'PROJECT_ROLE_CODES_INVALID',
    });
  }

  return roles;
}

function mapProjectMembershipResponse(membership: {
  id: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
  user: {
    id: string;
    email: string;
    displayName: string | null;
  };
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
}): ProjectMembershipResponse {
  return {
    membershipId: membership.id,
    user: membership.user,
    project: membership.project,
    status: membership.status,
    roles: membership.membershipRoles.map((membershipRole) => membershipRole.role),
  };
}

function isMembershipConflictError(error: unknown): error is PrismaClientKnownRequestError {
  return (
    error instanceof PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    Array.isArray(error.meta?.target) &&
    error.meta.target.includes('project_id') &&
    error.meta.target.includes('user_id')
  );
}

function encodeMembershipListCursor(createdAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: createdAt.toISOString(),
      id,
    }),
    'utf8',
  ).toString('base64url');
}
