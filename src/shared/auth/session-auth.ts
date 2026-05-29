import { createHash } from 'node:crypto';

import type { PrismaClient } from '../db/prisma-types.js';
import { UserStatus as UserStatusValues } from '../db/prisma-types.js';

import { AppError } from '../errors/app-error.js';

type SessionAuthDbClient = {
  session: PrismaClient['session'];
};

export interface AuthenticatedSession {
  session: {
    id: string;
    status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
    expiresAt: Date;
    user: {
      id: string;
      email: string;
      displayName: string | null;
      status: 'ACTIVE' | 'BANNED';
    };
  };
  user: {
    id: string;
    email: string;
    displayName: string | null;
    status: 'ACTIVE' | 'BANNED';
  };
}

export function getSessionTokenFromCookie(
  cookies: Record<string, string | undefined>,
  cookieName: string,
): string | null {
  return cookies[cookieName] ?? null;
}

export function hashSessionToken(sessionToken: string): string {
  return createHash('sha256').update(sessionToken).digest('hex');
}

export async function requireAuthenticatedSession(
  prisma: SessionAuthDbClient,
  sessionToken: string | null,
): Promise<AuthenticatedSession> {
  if (sessionToken === null) {
    throw unauthenticatedError();
  }

  const sessionSecretHash = hashSessionToken(sessionToken);
  const session = await prisma.session.findUnique({
    where: {
      secretHash: sessionSecretHash,
    },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          displayName: true,
          status: true,
        },
      },
    },
  });

  if (session === null) {
    throw unauthenticatedError();
  }

  if (session.status === 'REVOKED') {
    throw unauthenticatedError();
  }

  if (session.expiresAt.getTime() <= Date.now()) {
    if (session.status === 'ACTIVE') {
      await prisma.session.update({
        where: {
          id: session.id,
        },
        data: {
          status: 'EXPIRED',
        },
      });
    }

    throw unauthenticatedError();
  }

  if (session.user.status === UserStatusValues.BANNED) {
    throw bannedUserError();
  }

  return {
    session,
    user: session.user,
  };
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
