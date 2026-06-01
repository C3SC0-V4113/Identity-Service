import type { Prisma, PrismaClient } from '../../shared/db/prisma-types.js';

type PrismaDbClient = {
  localCredential: PrismaClient['localCredential'];
  project: PrismaClient['project'];
  projectMembership: PrismaClient['projectMembership'];
  projectRole: PrismaClient['projectRole'];
  session: PrismaClient['session'];
  user: PrismaClient['user'];
};

const projectSummarySelect = {
  id: true,
  slug: true,
  name: true,
  status: true,
} satisfies Prisma.ProjectSelect;

const projectRoleSummarySelect = {
  id: true,
  code: true,
  name: true,
} satisfies Prisma.ProjectRoleSelect;

const membershipRoleSelect = {
  role: {
    select: projectRoleSummarySelect,
  },
} satisfies Prisma.ProjectMembershipRoleSelect;

const membershipWithRolesSelect = {
  id: true,
  status: true,
  project: {
    select: projectSummarySelect,
  },
  membershipRoles: {
    orderBy: {
      role: {
        code: 'asc',
      },
    },
    select: membershipRoleSelect,
  },
} satisfies Prisma.ProjectMembershipSelect;

const projectAuthProfileSelect = {
  id: true,
  email: true,
  displayName: true,
  status: true,
  createdAt: true,
  memberships: {
    take: 1,
    select: membershipWithRolesSelect,
  },
} satisfies Prisma.UserSelect;

const projectSessionListSelect = {
  id: true,
  status: true,
  createdAt: true,
  lastSeenAt: true,
  expiresAt: true,
  ipAddress: true,
  userAgent: true,
  user: {
    select: {
      id: true,
      email: true,
      displayName: true,
    },
  },
} satisfies Prisma.SessionSelect;

type ProjectAuthProfileRecord = Awaited<ReturnType<typeof findProjectUserProfileById>>;
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

export async function findProjectBySlug(prisma: PrismaDbClient, slug: string) {
  return prisma.project.findUnique({
    where: {
      slug,
    },
    select: projectSummarySelect,
  });
}

export async function findProjectRoleByCode(
  prisma: PrismaDbClient,
  projectId: string,
  code: string,
) {
  return prisma.projectRole.findUnique({
    where: {
      projectId_code: {
        projectId,
        code,
      },
    },
    select: projectRoleSummarySelect,
  });
}

export async function findMembershipByProjectAndUser(
  prisma: PrismaDbClient,
  projectId: string,
  userId: string,
) {
  return prisma.projectMembership.findUnique({
    where: {
      projectId_userId: {
        projectId,
        userId,
      },
    },
    select: membershipWithRolesSelect,
  });
}

export async function createMembershipWithRole(
  prisma: PrismaDbClient,
  input: {
    projectId: string;
    userId: string;
    roleId: string;
  },
) {
  return prisma.projectMembership.create({
    data: {
      projectId: input.projectId,
      userId: input.userId,
      status: 'ACTIVE',
      membershipRoles: {
        create: {
          roleId: input.roleId,
        },
      },
    },
    select: membershipWithRolesSelect,
  });
}

export async function createSession(
  prisma: PrismaDbClient,
  input: {
    userId: string;
    projectId: string;
    secretHash: string;
    expiresAt: Date;
    ipAddress: string | null;
    userAgent: string | null;
  },
) {
  return prisma.session.create({
    data: {
      userId: input.userId,
      projectId: input.projectId,
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

export async function revokeActiveSessionByIdForProject(
  prisma: PrismaDbClient,
  input: {
    sessionId: string;
    projectId: string;
    revokedReason: string;
  },
) {
  return prisma.session.updateMany({
    where: {
      id: input.sessionId,
      projectId: input.projectId,
      status: 'ACTIVE',
    },
    data: {
      status: 'REVOKED',
      revokedAt: new Date(),
      revokedReason: input.revokedReason,
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

export async function findProjectUserProfileById(
  prisma: PrismaDbClient,
  input: {
    userId: string;
    projectId: string;
  },
) {
  return prisma.user.findUnique({
    where: {
      id: input.userId,
    },
    select: {
      ...projectAuthProfileSelect,
      memberships: {
        where: {
          projectId: input.projectId,
        },
        take: 1,
        select: membershipWithRolesSelect,
      },
    },
  });
}

export async function listSessionsByProject(
  prisma: PrismaDbClient,
  input: {
    projectId: string;
    limit: number;
    status?: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
    userId?: string;
    query?: {
      emailNormalized: string;
      displayName: string;
    };
    cursor?: {
      createdAt: Date;
      id: string;
    };
  },
) {
  const where: Prisma.SessionWhereInput = {
    projectId: input.projectId,
  };

  if (input.status !== undefined) {
    where.status = input.status;
  }

  if (input.userId !== undefined) {
    where.userId = input.userId;
  }

  if (input.query !== undefined) {
    where.user = {
      is: {
        OR: [
          {
            emailNormalized: {
              contains: input.query.emailNormalized,
            },
          },
          {
            displayName: {
              contains: input.query.displayName,
              mode: 'insensitive',
            },
          },
        ],
      },
    };
  }

  if (input.cursor !== undefined) {
    where.OR = [
      {
        createdAt: {
          lt: input.cursor.createdAt,
        },
      },
      {
        createdAt: input.cursor.createdAt,
        id: {
          lt: input.cursor.id,
        },
      },
    ];
  }

  return prisma.session.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: input.limit,
    select: projectSessionListSelect,
  });
}

export type AuthSessionRecord = NonNullable<SessionRecord>;
export type ProjectAuthProfile = NonNullable<ProjectAuthProfileRecord>;
