import type { PrismaClient } from '../../shared/db/prisma-types.js';

type PrismaDbClient = {
  user: PrismaClient['user'];
  localCredential: PrismaClient['localCredential'];
  session: PrismaClient['session'];
};

type UserProfileRecord = Awaited<ReturnType<typeof findUserProfileById>>;
type SessionRecord = Awaited<ReturnType<typeof findSessionBySecretHash>>;

export async function findUserByEmailNormalized(prisma: PrismaDbClient, emailNormalized: string) {
  return prisma.user.findUnique({
    where: {
      emailNormalized,
    },
  });
}

export async function findUserWithCredentialByEmailNormalized(
  prisma: PrismaDbClient,
  emailNormalized: string,
) {
  return prisma.user.findUnique({
    where: {
      emailNormalized,
    },
    include: {
      localCredential: true,
    },
  });
}

export async function createUserWithCredential(
  prisma: PrismaDbClient,
  input: {
    email: string;
    emailNormalized: string;
    displayName: string | null;
    passwordHash: string;
  },
) {
  return prisma.user.create({
    data: {
      email: input.email,
      emailNormalized: input.emailNormalized,
      displayName: input.displayName,
      localCredential: {
        create: {
          passwordHash: input.passwordHash,
        },
      },
    },
  });
}

export async function createSession(
  prisma: PrismaDbClient,
  input: {
    userId: string;
    secretHash: string;
    expiresAt: Date;
    ipAddress: string | null;
    userAgent: string | null;
  },
) {
  return prisma.session.create({
    data: {
      userId: input.userId,
      secretHash: input.secretHash,
      expiresAt: input.expiresAt,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    },
  });
}

export async function findSessionBySecretHash(prisma: PrismaDbClient, secretHash: string) {
  return prisma.session.findUnique({
    where: {
      secretHash,
    },
    include: {
      user: true,
    },
  });
}

export async function revokeSessionById(
  prisma: PrismaDbClient,
  sessionId: string,
  revokedReason: string,
) {
  return prisma.session.update({
    where: {
      id: sessionId,
    },
    data: {
      status: 'REVOKED',
      revokedAt: new Date(),
      revokedReason,
    },
  });
}

export async function markSessionExpired(prisma: PrismaDbClient, sessionId: string) {
  return prisma.session.update({
    where: {
      id: sessionId,
    },
    data: {
      status: 'EXPIRED',
    },
  });
}

export async function updateSessionLastSeenAt(
  prisma: PrismaDbClient,
  sessionId: string,
  lastSeenAt: Date,
) {
  return prisma.session.update({
    where: {
      id: sessionId,
    },
    data: {
      lastSeenAt,
    },
  });
}

export async function findUserProfileById(prisma: PrismaDbClient, userId: string) {
  return prisma.user.findUnique({
    where: {
      id: userId,
    },
    select: {
      id: true,
      email: true,
      displayName: true,
      status: true,
      createdAt: true,
      memberships: {
        orderBy: {
          createdAt: 'asc',
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
      },
    },
  });
}

export type AuthSessionRecord = NonNullable<SessionRecord>;
export type AuthUserProfileRecord = NonNullable<UserProfileRecord>;
