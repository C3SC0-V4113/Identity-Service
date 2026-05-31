import type { Prisma, PrismaClient } from '../../shared/db/prisma-types.js';

type PrismaDbClient = {
  project: PrismaClient['project'];
  projectRole: PrismaClient['projectRole'];
  projectMembership: PrismaClient['projectMembership'];
  projectMembershipRole: PrismaClient['projectMembershipRole'];
  projectMembershipAuditLog: PrismaClient['projectMembershipAuditLog'];
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

const membershipWithRolesSelect = {
  id: true,
  status: true,
  user: {
    select: {
      id: true,
      email: true,
      displayName: true,
    },
  },
  project: {
    select: projectSummarySelect,
  },
  membershipRoles: {
    orderBy: {
      role: {
        code: 'asc',
      },
    },
    select: {
      role: {
        select: projectRoleSummarySelect,
      },
    },
  },
} satisfies Prisma.ProjectMembershipSelect;

const membershipListSelect = {
  id: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  user: {
    select: {
      id: true,
      email: true,
      displayName: true,
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
        select: projectRoleSummarySelect,
      },
    },
  },
} satisfies Prisma.ProjectMembershipSelect;

const auditLogListSelect = {
  id: true,
  action: true,
  membershipId: true,
  fromStatus: true,
  toStatus: true,
  fromRoleCodes: true,
  toRoleCodes: true,
  createdAt: true,
  actorUser: {
    select: {
      id: true,
      email: true,
      displayName: true,
    },
  },
  targetUser: {
    select: {
      id: true,
      email: true,
      displayName: true,
    },
  },
} satisfies Prisma.ProjectMembershipAuditLogSelect;

export async function findProjectBySlug(prisma: PrismaDbClient, slug: string) {
  return prisma.project.findUnique({
    where: {
      slug,
    },
    select: projectSummarySelect,
  });
}

export async function findProjectRolesByCodes(
  prisma: PrismaDbClient,
  projectId: string,
  roleCodes: readonly string[],
) {
  return prisma.projectRole.findMany({
    where: {
      projectId,
      code: {
        in: [...roleCodes],
      },
    },
    orderBy: {
      code: 'asc',
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
    select: {
      id: true,
      status: true,
      projectId: true,
      userId: true,
    },
  });
}

export async function findMembershipWithRolesByProjectAndUser(
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

export async function listMembershipsByProject(
  prisma: PrismaDbClient,
  input: {
    projectId: string;
    limit: number;
    status?: 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
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
  const where: Prisma.ProjectMembershipWhereInput = {
    projectId: input.projectId,
  };

  if (input.status !== undefined) {
    where.status = input.status;
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

  return prisma.projectMembership.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: input.limit,
    select: membershipListSelect,
  });
}

export async function countOtherActiveAdminMemberships(
  prisma: PrismaDbClient,
  input: {
    projectId: string;
    excludeMembershipId: string;
  },
) {
  return prisma.projectMembership.count({
    where: {
      projectId: input.projectId,
      status: 'ACTIVE',
      id: {
        not: input.excludeMembershipId,
      },
      membershipRoles: {
        some: {
          role: {
            code: 'admin',
          },
        },
      },
    },
  });
}

export async function createMembershipWithRoles(
  prisma: PrismaDbClient,
  input: {
    projectId: string;
    userId: string;
    roleIds: readonly string[];
  },
) {
  return prisma.projectMembership.create({
    data: {
      projectId: input.projectId,
      userId: input.userId,
      status: 'ACTIVE',
      membershipRoles: {
        create: input.roleIds.map((roleId) => ({
          roleId,
        })),
      },
    },
    select: membershipWithRolesSelect,
  });
}

export async function replaceMembershipRoles(
  prisma: PrismaDbClient,
  input: {
    membershipId: string;
    roleIds: readonly string[];
  },
) {
  await prisma.projectMembershipRole.deleteMany({
    where: {
      membershipId: input.membershipId,
    },
  });

  await prisma.projectMembershipRole.createMany({
    data: input.roleIds.map((roleId) => ({
      membershipId: input.membershipId,
      roleId,
    })),
  });

  return prisma.projectMembership.findUniqueOrThrow({
    where: {
      id: input.membershipId,
    },
    select: membershipWithRolesSelect,
  });
}

export async function updateMembershipStatus(
  prisma: PrismaDbClient,
  input: {
    membershipId: string;
    status: 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
  },
) {
  return prisma.projectMembership.update({
    where: {
      id: input.membershipId,
    },
    data: {
      status: input.status,
    },
    select: membershipWithRolesSelect,
  });
}

export async function createProjectMembershipAuditLog(
  prisma: PrismaDbClient,
  input: {
    action: 'CREATED' | 'ROLES_REPLACED' | 'SUSPENDED' | 'REACTIVATED' | 'REVOKED';
    projectId: string;
    membershipId: string;
    actorUserId: string;
    targetUserId: string;
    fromStatus: 'ACTIVE' | 'SUSPENDED' | 'REVOKED' | null;
    toStatus: 'ACTIVE' | 'SUSPENDED' | 'REVOKED' | null;
    fromRoleCodes: readonly string[];
    toRoleCodes: readonly string[];
  },
) {
  return prisma.projectMembershipAuditLog.create({
    data: {
      action: input.action,
      projectId: input.projectId,
      membershipId: input.membershipId,
      actorUserId: input.actorUserId,
      targetUserId: input.targetUserId,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      fromRoleCodes: [...input.fromRoleCodes],
      toRoleCodes: [...input.toRoleCodes],
    },
  });
}

export type ProjectAuditLogListRecord = Awaited<ReturnType<typeof listAuditLogsByProject>>[number];

export async function listAuditLogsByProject(
  prisma: PrismaDbClient,
  input: {
    projectId: string;
    limit: number;
    action?: 'CREATED' | 'ROLES_REPLACED' | 'SUSPENDED' | 'REACTIVATED' | 'REVOKED';
    targetUserId?: string;
    membershipId?: string;
    cursor?: {
      createdAt: Date;
      id: string;
    };
  },
) {
  const where: Prisma.ProjectMembershipAuditLogWhereInput = {
    projectId: input.projectId,
  };

  if (input.action !== undefined) {
    where.action = input.action;
  }

  if (input.targetUserId !== undefined) {
    where.targetUserId = input.targetUserId;
  }

  if (input.membershipId !== undefined) {
    where.membershipId = input.membershipId;
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

  return prisma.projectMembershipAuditLog.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: input.limit,
    select: auditLogListSelect,
  });
}

export async function findUserByEmailNormalized(prisma: PrismaDbClient, emailNormalized: string) {
  return prisma.user.findUnique({
    where: {
      emailNormalized,
    },
    select: {
      id: true,
      email: true,
      displayName: true,
    },
  });
}
