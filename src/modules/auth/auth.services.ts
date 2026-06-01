import { randomBytes } from 'node:crypto';

import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import argon2 from 'argon2';

import { normalizeEmail } from '../../shared/auth/email.js';
import {
  hashSessionToken,
  requireAuthenticatedProjectSession,
} from '../../shared/auth/session-auth.js';
import type { PrismaClient } from '../../shared/db/prisma-types.js';
import { UserStatus } from '../../shared/db/prisma-types.js';
import { AppError } from '../../shared/errors/app-error.js';
import {
  requireProjectAdmin,
  requireProjectBySlug,
} from '../project-memberships/project-memberships.guards.js';
import {
  createMembershipWithRole,
  createSession,
  createUserWithCredential,
  findMembershipByProjectAndUser,
  findProjectBySlug,
  findProjectRoleByCode,
  findProjectUserProfileById,
  findSessionBySecretHash,
  findUserByEmailNormalized,
  findUserWithCredentialByEmailNormalized,
  listSessionsByProject,
  markSessionExpired,
  revokeActiveSessionByIdForProject,
  revokeSessionById,
  updateSessionLastSeenAt,
  type ProjectAuthProfile,
} from './auth.repositories.js';
import type {
  ProjectAuthLoginRequest,
  ProjectAuthRegisterRequest,
  ProjectAuthResponse,
  ProjectSessionListQuery,
  ProjectSessionListResponse,
  RegisterEmailCheckResponse,
} from './auth.schemas.js';
import { getSessionExpiresAt } from './auth.cookies.js';

export interface SessionContext {
  ipAddress: string | null;
  userAgent: string | null;
}

const defaultProjectRoleCode = 'user';
const sessionTokenBytes = 32;

const paginationCursorSchema = {
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
        code: 'PROJECT_SESSION_CURSOR_INVALID',
      });
    }
  },
};

export async function checkRegistrationEmail(
  prisma: PrismaClient,
  input: {
    projectSlug: string;
    email: string;
  },
): Promise<RegisterEmailCheckResponse> {
  await requireProjectBySlug(prisma, input.projectSlug);

  const email = input.email.trim();
  const existingUser = await findUserByEmailNormalized(prisma, normalizeEmail(email));

  return {
    email,
    exists: existingUser !== null,
    nextStep: existingUser === null ? 'REGISTER' : 'LOGIN',
  };
}

export async function registerUser(
  prisma: PrismaClient,
  input: {
    projectSlug: string;
    body: ProjectAuthRegisterRequest;
  },
  sessionContext: SessionContext,
): Promise<{ sessionToken: string; response: ProjectAuthResponse }> {
  const project = await requireProjectBySlug(prisma, input.projectSlug);
  const email = input.body.email.trim();
  const emailNormalized = normalizeEmail(email);
  const displayName = input.body.displayName?.trim() ?? null;

  const existingUser = await findUserByEmailNormalized(prisma, emailNormalized);

  if (existingUser !== null) {
    throw new AppError('Email address is already registered', {
      statusCode: 409,
      code: 'EMAIL_ALREADY_EXISTS',
    });
  }

  const passwordHash = await argon2.hash(input.body.password);
  const sessionToken = generateSessionToken();
  const sessionSecretHash = hashSessionToken(sessionToken);

  try {
    const created = await prisma.$transaction(async (transactionClient: unknown) => {
      const tx = transactionClient as unknown as PrismaClient;
      const defaultRole = await requireDefaultProjectRole(tx, project.id);
      const user = await createUserWithCredential(tx, {
        email,
        emailNormalized,
        displayName,
        passwordHash,
      });
      const membership = await createMembershipWithRole(tx, {
        projectId: project.id,
        userId: user.id,
        roleId: defaultRole.id,
      });

      await createSession(tx, {
        userId: user.id,
        projectId: project.id,
        secretHash: sessionSecretHash,
        expiresAt: getSessionExpiresAt(new Date()),
        ipAddress: sessionContext.ipAddress,
        userAgent: sessionContext.userAgent,
      });

      return {
        user,
        membership,
      };
    });

    return {
      sessionToken,
      response: mapProjectAuthResponse({
        user: created.user,
        project,
        membership: created.membership,
      }),
    };
  } catch (error: unknown) {
    if (isEmailConflictError(error)) {
      throw new AppError('Email address is already registered', {
        statusCode: 409,
        code: 'EMAIL_ALREADY_EXISTS',
      });
    }

    throw error;
  }
}

export async function loginUser(
  prisma: PrismaClient,
  input: {
    projectSlug: string;
    body: ProjectAuthLoginRequest;
  },
  sessionContext: SessionContext,
): Promise<{ sessionToken: string; response: ProjectAuthResponse }> {
  const project = await requireProjectBySlug(prisma, input.projectSlug);
  const emailNormalized = normalizeEmail(input.body.email);
  const user = await findUserWithCredentialByEmailNormalized(prisma, emailNormalized);

  if (user?.localCredential === null || user === null) {
    throw invalidCredentialsError();
  }

  const isValidPassword = await argon2.verify(
    user.localCredential.passwordHash,
    input.body.password,
  );

  if (!isValidPassword) {
    throw invalidCredentialsError();
  }

  if (user.status === UserStatus.BANNED) {
    throw bannedUserError();
  }

  const sessionToken = generateSessionToken();
  const sessionSecretHash = hashSessionToken(sessionToken);
  const expiresAt = getSessionExpiresAt(new Date());

  const membership = await prisma.$transaction(async (transactionClient: unknown) => {
    const tx = transactionClient as unknown as PrismaClient;
    const resolvedMembership = await ensureProjectMembershipForLogin(tx, {
      projectId: project.id,
      userId: user.id,
    });

    await createSession(tx, {
      userId: user.id,
      projectId: project.id,
      secretHash: sessionSecretHash,
      expiresAt,
      ipAddress: sessionContext.ipAddress,
      userAgent: sessionContext.userAgent,
    });

    return resolvedMembership;
  });

  return {
    sessionToken,
    response: mapProjectAuthResponse({
      user,
      project,
      membership,
    }),
  };
}

export async function logoutUser(
  prisma: PrismaClient,
  input: {
    projectSlug: string;
    sessionToken: string | null;
  },
): Promise<void> {
  const project = await requireProjectExists(prisma, input.projectSlug);

  if (input.sessionToken === null) {
    return;
  }

  const sessionSecretHash = hashSessionToken(input.sessionToken);
  const session = await findSessionBySecretHash(prisma, sessionSecretHash);

  if (session?.projectId !== project.id) {
    return;
  }

  if (session.status !== 'ACTIVE') {
    return;
  }

  if (session.expiresAt.getTime() <= Date.now()) {
    await markSessionExpired(prisma, session.id);
    return;
  }

  await revokeSessionById(prisma, session.id, 'USER_LOGOUT');
}

export async function getAuthenticatedUser(
  prisma: PrismaClient,
  input: {
    projectSlug: string;
    sessionToken: string | null;
    touchSession: boolean;
  },
): Promise<ProjectAuthResponse> {
  const project = await requireProjectBySlug(prisma, input.projectSlug);
  const authenticatedSession = await requireAuthenticatedProjectSession(
    prisma,
    input.sessionToken,
    project.id,
  );

  if (input.touchSession) {
    await updateSessionLastSeenAt(prisma, authenticatedSession.session.id, new Date());
  }

  const profile = await findProjectUserProfileById(prisma, {
    userId: authenticatedSession.user.id,
    projectId: project.id,
  });

  if (profile === null) {
    throw new AppError('Authenticated user profile could not be loaded', {
      statusCode: 500,
      code: 'AUTH_PROFILE_NOT_FOUND',
    });
  }

  return mapProjectAuthResponse({
    user: profile,
    project,
    membership: profile.memberships[0] ?? null,
  });
}

export async function validateCurrentSession(
  prisma: PrismaClient,
  input: {
    projectSlug: string;
    sessionToken: string | null;
  },
): Promise<void> {
  const project = await requireProjectBySlug(prisma, input.projectSlug);

  await requireAuthenticatedProjectSession(prisma, input.sessionToken, project.id);
}

export async function listProjectSessionsForAdmin(
  prisma: PrismaClient,
  input: {
    projectSlug: string;
    sessionToken: string | null;
    query: ProjectSessionListQuery;
  },
): Promise<ProjectSessionListResponse> {
  const project = await requireProjectBySlug(prisma, input.projectSlug);
  const authenticatedSession = await requireAuthenticatedProjectSession(
    prisma,
    input.sessionToken,
    project.id,
  );

  await requireProjectAdmin(prisma, project.id, authenticatedSession.user.id);

  const queryText = input.query.q?.trim();
  const records = await listSessionsByProject(prisma, {
    projectId: project.id,
    limit: input.query.limit + 1,
    status: input.query.status,
    userId: input.query.userId,
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
        : paginationCursorSchema.parse(input.query.cursor),
  });

  const hasMore = records.length > input.query.limit;
  const pageItems = hasMore ? records.slice(0, input.query.limit) : records;
  const lastItem = pageItems.at(-1);

  return {
    project: {
      id: project.id,
      slug: project.slug,
      name: project.name,
    },
    items: pageItems.map((session) => ({
      id: session.id,
      status: session.status,
      createdAt: session.createdAt.toISOString(),
      lastSeenAt: session.lastSeenAt?.toISOString() ?? null,
      expiresAt: session.expiresAt.toISOString(),
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
      user: session.user,
    })),
    page: {
      nextCursor:
        hasMore && lastItem !== undefined
          ? encodePaginationCursor(lastItem.createdAt, lastItem.id)
          : null,
      hasMore,
      limit: input.query.limit,
    },
  };
}

export async function revokeProjectSessionForAdmin(
  prisma: PrismaClient,
  input: {
    projectSlug: string;
    sessionToken: string | null;
    sessionId: string;
  },
): Promise<void> {
  const project = await requireProjectBySlug(prisma, input.projectSlug);
  const authenticatedSession = await requireAuthenticatedProjectSession(
    prisma,
    input.sessionToken,
    project.id,
  );

  await requireProjectAdmin(prisma, project.id, authenticatedSession.user.id);

  const result = await revokeActiveSessionByIdForProject(prisma, {
    sessionId: input.sessionId,
    projectId: project.id,
    revokedReason: 'PROJECT_ADMIN_REVOKED',
  });

  if (result.count === 0) {
    throw new AppError('Session not found', {
      statusCode: 404,
      code: 'SESSION_NOT_FOUND',
    });
  }
}

function generateSessionToken(): string {
  return randomBytes(sessionTokenBytes).toString('base64url');
}

async function ensureProjectMembershipForLogin(
  prisma: PrismaClient,
  input: {
    projectId: string;
    userId: string;
  },
) {
  const existingMembership = await findMembershipByProjectAndUser(
    prisma,
    input.projectId,
    input.userId,
  );

  if (existingMembership === null) {
    const defaultRole = await requireDefaultProjectRole(prisma, input.projectId);

    return createMembershipWithRole(prisma, {
      projectId: input.projectId,
      userId: input.userId,
      roleId: defaultRole.id,
    });
  }

  ensureMembershipCanAuthenticate(existingMembership.status);

  return existingMembership;
}

function ensureMembershipCanAuthenticate(status: 'ACTIVE' | 'SUSPENDED' | 'REVOKED') {
  if (status === 'ACTIVE') {
    return;
  }

  if (status === 'SUSPENDED') {
    throw new AppError('Project membership is suspended', {
      statusCode: 403,
      code: 'PROJECT_MEMBERSHIP_SUSPENDED',
    });
  }

  throw new AppError('Project membership is revoked', {
    statusCode: 403,
    code: 'PROJECT_MEMBERSHIP_REVOKED',
  });
}

async function requireDefaultProjectRole(prisma: PrismaClient, projectId: string) {
  const role = await findProjectRoleByCode(prisma, projectId, defaultProjectRoleCode);

  if (role !== null) {
    return role;
  }

  throw new AppError('Default project role is not configured', {
    statusCode: 500,
    code: 'PROJECT_DEFAULT_ROLE_NOT_FOUND',
  });
}

async function requireProjectExists(prisma: PrismaClient, projectSlug: string) {
  const project = await findProjectBySlug(prisma, projectSlug);

  if (project !== null) {
    return project;
  }

  throw new AppError('Project not found', {
    statusCode: 404,
    code: 'PROJECT_NOT_FOUND',
  });
}

function mapProjectAuthResponse(input: {
  user: {
    id: string;
    email: string;
    displayName: string | null;
    status: 'ACTIVE' | 'BANNED';
    createdAt: Date;
  };
  project: {
    id: string;
    slug: string;
    name: string;
  };
  membership: ProjectAuthProfile['memberships'][number] | null;
}): ProjectAuthResponse {
  return {
    user: {
      id: input.user.id,
      email: input.user.email,
      displayName: input.user.displayName,
      status: input.user.status,
      createdAt: input.user.createdAt.toISOString(),
    },
    project: {
      id: input.project.id,
      slug: input.project.slug,
      name: input.project.name,
    },
    membership:
      input.membership === null
        ? null
        : {
            id: input.membership.id,
            status: input.membership.status,
            roles: input.membership.membershipRoles.map((membershipRole) => membershipRole.role),
          },
  };
}

function invalidCredentialsError(): AppError {
  return new AppError('Invalid email or password', {
    statusCode: 401,
    code: 'INVALID_CREDENTIALS',
  });
}

function bannedUserError(): AppError {
  return new AppError('User is banned', {
    statusCode: 403,
    code: 'USER_BANNED',
  });
}

function isEmailConflictError(error: unknown): error is PrismaClientKnownRequestError {
  return (
    error instanceof PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    Array.isArray(error.meta?.target) &&
    error.meta.target.includes('email_normalized')
  );
}

function encodePaginationCursor(createdAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: createdAt.toISOString(),
      id,
    }),
    'utf8',
  ).toString('base64url');
}
