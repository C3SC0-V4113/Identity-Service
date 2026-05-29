import { AppError } from '../../shared/errors/app-error.js';
import {
  findMembershipWithRolesByProjectAndUser,
  findProjectBySlug,
} from './project-memberships.repositories.js';

type PrismaDbClient = Parameters<typeof findProjectBySlug>[0];

export async function requireProjectBySlug(prisma: PrismaDbClient, slug: string) {
  const project = await findProjectBySlug(prisma, slug);

  if (project === null) {
    throw new AppError('Project not found', {
      statusCode: 404,
      code: 'PROJECT_NOT_FOUND',
    });
  }

  return project;
}

export async function requireProjectAdmin(
  prisma: PrismaDbClient,
  projectId: string,
  userId: string,
) {
  const membership = await findMembershipWithRolesByProjectAndUser(prisma, projectId, userId);
  const isAdmin =
    membership?.status === 'ACTIVE' &&
    membership.membershipRoles.some(
      (membershipRole: (typeof membership.membershipRoles)[number]) =>
        membershipRole.role.code === 'admin',
    );

  if (!isAdmin) {
    throw new AppError('Project admin role required', {
      statusCode: 403,
      code: 'PROJECT_ADMIN_REQUIRED',
    });
  }

  return membership;
}
