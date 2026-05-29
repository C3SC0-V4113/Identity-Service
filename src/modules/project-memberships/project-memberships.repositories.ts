import type { Prisma, PrismaClient } from '../../shared/db/prisma-types.js';

type PrismaDbClient = {
  project: PrismaClient['project'];
  projectRole: PrismaClient['projectRole'];
  projectMembership: PrismaClient['projectMembership'];
  projectMembershipRole: PrismaClient['projectMembershipRole'];
  user: PrismaClient['user'];
};

const projectSummarySelect = {
  id: true,
  slug: true,
  name: true,
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
