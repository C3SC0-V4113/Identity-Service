import { createHash, randomBytes } from 'node:crypto';

import argon2 from 'argon2';
import type { PrismaClient } from '@prisma/client';
import { UserStatus } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';

import { AppError } from '../../shared/errors/app-error.js';
import {
  createSession,
  createUserWithCredential,
  findSessionBySecretHash,
  findUserByEmailNormalized,
  findUserProfileById,
  findUserWithCredentialByEmailNormalized,
  markSessionExpired,
  revokeSessionById,
  updateSessionLastSeenAt,
  type AuthUserProfileRecord,
} from './auth.repositories.js';
import type {
  AuthResponse,
  AuthUserResponse,
  LoginRequest,
  RegisterRequest,
} from './auth.schemas.js';
import { getSessionExpiresAt } from './auth.cookies.js';

export interface SessionContext {
  ipAddress: string | null;
  userAgent: string | null;
}

const sessionTokenBytes = 32;

export async function registerUser(
  prisma: PrismaClient,
  input: RegisterRequest,
  sessionContext: SessionContext,
): Promise<{ sessionToken: string; response: AuthResponse }> {
  const email = input.email.trim();
  const emailNormalized = normalizeEmail(email);
  const displayName = input.displayName?.trim() ?? null;

  const existingUser = await findUserByEmailNormalized(prisma, emailNormalized);

  if (existingUser !== null) {
    throw new AppError('Email address is already registered', {
      statusCode: 409,
      code: 'EMAIL_ALREADY_EXISTS',
    });
  }

  const passwordHash = await argon2.hash(input.password);
  const sessionToken = generateSessionToken();
  const sessionSecretHash = hashSessionToken(sessionToken);

  try {
    const createdUser = await prisma.$transaction(async (tx) => {
      const user = await createUserWithCredential(tx, {
        email,
        emailNormalized,
        displayName,
        passwordHash,
      });

      await createSession(tx, {
        userId: user.id,
        secretHash: sessionSecretHash,
        expiresAt: getSessionExpiresAt(new Date()),
        ipAddress: sessionContext.ipAddress,
        userAgent: sessionContext.userAgent,
      });

      return user;
    });

    return {
      sessionToken,
      response: {
        user: mapUserResponse({
          id: createdUser.id,
          email: createdUser.email,
          displayName: createdUser.displayName,
          status: createdUser.status,
          createdAt: createdUser.createdAt,
          memberships: [],
        }),
      },
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
  input: LoginRequest,
  sessionContext: SessionContext,
): Promise<{ sessionToken: string; response: AuthResponse }> {
  const emailNormalized = normalizeEmail(input.email);
  const user = await findUserWithCredentialByEmailNormalized(prisma, emailNormalized);

  if (user?.localCredential === null || user === null) {
    throw invalidCredentialsError();
  }

  const isValidPassword = await argon2.verify(user.localCredential.passwordHash, input.password);

  if (!isValidPassword) {
    throw invalidCredentialsError();
  }

  if (user.status === UserStatus.BANNED) {
    throw bannedUserError();
  }

  const sessionToken = generateSessionToken();
  const sessionSecretHash = hashSessionToken(sessionToken);
  const expiresAt = getSessionExpiresAt(new Date());

  await prisma.$transaction(async (tx) => {
    await createSession(tx, {
      userId: user.id,
      secretHash: sessionSecretHash,
      expiresAt,
      ipAddress: sessionContext.ipAddress,
      userAgent: sessionContext.userAgent,
    });
  });

  const profile = await findUserProfileById(prisma, user.id);

  if (profile === null) {
    throw new AppError('Authenticated user profile could not be loaded', {
      statusCode: 500,
      code: 'AUTH_PROFILE_NOT_FOUND',
    });
  }

  return {
    sessionToken,
    response: {
      user: mapUserResponse(profile),
    },
  };
}

export async function logoutUser(prisma: PrismaClient, sessionToken: string | null): Promise<void> {
  if (sessionToken === null) {
    return;
  }

  const sessionSecretHash = hashSessionToken(sessionToken);
  const session = await findSessionBySecretHash(prisma, sessionSecretHash);

  if (session === null) {
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
  sessionToken: string | null,
  options: { touchSession: boolean },
): Promise<AuthResponse> {
  const activeSession = await requireAuthenticatedSession(prisma, sessionToken);

  if (options.touchSession) {
    await updateSessionLastSeenAt(prisma, activeSession.session.id, new Date());
  }

  const profile = await findUserProfileById(prisma, activeSession.user.id);

  if (profile === null) {
    throw new AppError('Authenticated user profile could not be loaded', {
      statusCode: 500,
      code: 'AUTH_PROFILE_NOT_FOUND',
    });
  }

  return {
    user: mapUserResponse(profile),
  };
}

export function getSessionTokenFromCookie(
  cookies: Record<string, string | undefined>,
  cookieName: string,
): string | null {
  return cookies[cookieName] ?? null;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function generateSessionToken(): string {
  return randomBytes(sessionTokenBytes).toString('base64url');
}

function hashSessionToken(sessionToken: string): string {
  return createHash('sha256').update(sessionToken).digest('hex');
}

async function requireAuthenticatedSession(prisma: PrismaClient, sessionToken: string | null) {
  if (sessionToken === null) {
    throw unauthenticatedError();
  }

  const sessionSecretHash = hashSessionToken(sessionToken);
  const session = await findSessionBySecretHash(prisma, sessionSecretHash);

  if (session === null) {
    throw unauthenticatedError();
  }

  if (session.status === 'REVOKED') {
    throw unauthenticatedError();
  }

  if (session.expiresAt.getTime() <= Date.now()) {
    if (session.status === 'ACTIVE') {
      await markSessionExpired(prisma, session.id);
    }

    throw unauthenticatedError();
  }

  if (session.user.status === UserStatus.BANNED) {
    throw bannedUserError();
  }

  return {
    session,
    user: session.user,
  };
}

function mapUserResponse(profile: AuthUserProfileRecord): AuthUserResponse {
  return {
    id: profile.id,
    email: profile.email,
    displayName: profile.displayName,
    status: profile.status,
    createdAt: profile.createdAt.toISOString(),
    memberships: profile.memberships.map((membership) => ({
      id: membership.id,
      status: membership.status,
      project: membership.project,
      roles: membership.membershipRoles.map((membershipRole) => membershipRole.role),
    })),
  };
}

function invalidCredentialsError(): AppError {
  return new AppError('Invalid email or password', {
    statusCode: 401,
    code: 'INVALID_CREDENTIALS',
  });
}

function unauthenticatedError(): AppError {
  return new AppError('Authentication required', {
    statusCode: 401,
    code: 'AUTHENTICATION_REQUIRED',
  });
}

function bannedUserError(): AppError {
  return new AppError('User is banned', {
    statusCode: 403,
    code: 'USER_BANNED',
  });
}

function isEmailConflictError(error: unknown): boolean {
  return (
    error instanceof PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    Array.isArray(error.meta?.target) &&
    error.meta.target.includes('email_normalized')
  );
}
