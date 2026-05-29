import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';
import { authResponseSchema } from '../auth/auth.schemas.js';
import { upsertProjectSeedData } from '../identity/bootstrap/project-seed.js';
import {
  projectAccessResponseSchema,
  projectMembershipResponseSchema,
} from './project-memberships.schemas.js';

describe('project membership routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
  });

  beforeEach(async () => {
    await clearIdentityData();
    await upsertProjectSeedData(app.prisma);
  });

  afterAll(async () => {
    await clearIdentityData();
    await app.close();
  });

  it('returns project access with roles for an active member', async () => {
    const registeredUser = await registerUser({
      email: 'person@example.com',
      password: 'supersecret',
      displayName: 'Person',
    });

    await createMembership({
      userId: registeredUser.userId,
      projectSlug: 'other-gpt',
      roleCodes: ['admin', 'pro'],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/projects/other-gpt/me',
      headers: {
        cookie: registeredUser.cookie,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(projectAccessResponseSchema.parse(response.json())).toEqual({
      project: {
        id: expect.any(String),
        slug: 'other-gpt',
        name: 'Other GPT',
      },
      access: {
        isMember: true,
        membershipId: expect.any(String),
        status: 'ACTIVE',
        roles: [
          {
            id: expect.any(String),
            code: 'admin',
            name: 'Admin',
          },
          {
            id: expect.any(String),
            code: 'pro',
            name: 'Pro',
          },
        ],
        isAdmin: true,
      },
    });
  });

  it('returns isMember=false when the authenticated user has no membership in the project', async () => {
    const registeredUser = await registerUser({
      email: 'person@example.com',
      password: 'supersecret',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/projects/cost-console/me',
      headers: {
        cookie: registeredUser.cookie,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(projectAccessResponseSchema.parse(response.json())).toEqual({
      project: {
        id: expect.any(String),
        slug: 'cost-console',
        name: 'Cost Console',
      },
      access: {
        isMember: false,
        membershipId: null,
        status: null,
        roles: [],
        isAdmin: false,
      },
    });
  });

  it('returns 404 when the project does not exist', async () => {
    const registeredUser = await registerUser({
      email: 'person@example.com',
      password: 'supersecret',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/projects/unknown/me',
      headers: {
        cookie: registeredUser.cookie,
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: 'PROJECT_NOT_FOUND',
        message: 'Project not found',
      },
    });
  });

  it('creates a project membership with valid project roles', async () => {
    const adminUser = await registerUser({
      email: 'admin@example.com',
      password: 'supersecret',
    });
    const targetUser = await registerUser({
      email: 'target@example.com',
      password: 'supersecret',
      displayName: 'Target',
    });

    await createMembership({
      userId: adminUser.userId,
      projectSlug: 'other-gpt',
      roleCodes: ['admin'],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/projects/other-gpt/memberships',
      headers: {
        cookie: adminUser.cookie,
      },
      payload: {
        email: ' TARGET@example.com ',
        roleCodes: ['user', 'pro'],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(projectMembershipResponseSchema.parse(response.json())).toEqual({
      membershipId: expect.any(String),
      user: {
        id: targetUser.userId,
        email: 'target@example.com',
        displayName: 'Target',
      },
      project: {
        id: expect.any(String),
        slug: 'other-gpt',
        name: 'Other GPT',
      },
      status: 'ACTIVE',
      roles: [
        {
          id: expect.any(String),
          code: 'pro',
          name: 'Pro',
        },
        {
          id: expect.any(String),
          code: 'user',
          name: 'User',
        },
      ],
    });
  });

  it('rejects membership creation when the caller is not a project admin', async () => {
    const caller = await registerUser({
      email: 'person@example.com',
      password: 'supersecret',
    });
    await registerUser({
      email: 'target@example.com',
      password: 'supersecret',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/projects/other-gpt/memberships',
      headers: {
        cookie: caller.cookie,
      },
      payload: {
        email: 'target@example.com',
        roleCodes: ['user'],
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'PROJECT_ADMIN_REQUIRED',
        message: 'Project admin role required',
      },
    });
  });

  it('rejects membership creation when the target user does not exist', async () => {
    const adminUser = await registerUser({
      email: 'admin@example.com',
      password: 'supersecret',
    });

    await createMembership({
      userId: adminUser.userId,
      projectSlug: 'other-gpt',
      roleCodes: ['admin'],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/projects/other-gpt/memberships',
      headers: {
        cookie: adminUser.cookie,
      },
      payload: {
        email: 'missing@example.com',
        roleCodes: ['user'],
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      },
    });
  });

  it('rejects membership creation when the membership already exists', async () => {
    const adminUser = await registerUser({
      email: 'admin@example.com',
      password: 'supersecret',
    });
    const targetUser = await registerUser({
      email: 'target@example.com',
      password: 'supersecret',
    });

    await createMembership({
      userId: adminUser.userId,
      projectSlug: 'other-gpt',
      roleCodes: ['admin'],
    });
    await createMembership({
      userId: targetUser.userId,
      projectSlug: 'other-gpt',
      roleCodes: ['user'],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/projects/other-gpt/memberships',
      headers: {
        cookie: adminUser.cookie,
      },
      payload: {
        email: 'target@example.com',
        roleCodes: ['pro'],
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: 'PROJECT_MEMBERSHIP_ALREADY_EXISTS',
        message: 'Project membership already exists',
      },
    });
  });

  it('replaces the complete set of project roles for a membership', async () => {
    const adminUser = await registerUser({
      email: 'admin@example.com',
      password: 'supersecret',
    });
    const targetUser = await registerUser({
      email: 'target@example.com',
      password: 'supersecret',
    });

    await createMembership({
      userId: adminUser.userId,
      projectSlug: 'other-gpt',
      roleCodes: ['admin'],
    });
    await createMembership({
      userId: targetUser.userId,
      projectSlug: 'other-gpt',
      roleCodes: ['user', 'pro'],
    });

    const response = await app.inject({
      method: 'PUT',
      url: `/projects/other-gpt/memberships/${targetUser.userId}/roles`,
      headers: {
        cookie: adminUser.cookie,
      },
      payload: {
        roleCodes: ['admin'],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(projectMembershipResponseSchema.parse(response.json())).toEqual({
      membershipId: expect.any(String),
      user: {
        id: targetUser.userId,
        email: 'target@example.com',
        displayName: null,
      },
      project: {
        id: expect.any(String),
        slug: 'other-gpt',
        name: 'Other GPT',
      },
      status: 'ACTIVE',
      roles: [
        {
          id: expect.any(String),
          code: 'admin',
          name: 'Admin',
        },
      ],
    });
  });

  it('removes prior project roles that are not present in the replacement set', async () => {
    const adminUser = await registerUser({
      email: 'admin@example.com',
      password: 'supersecret',
    });
    const targetUser = await registerUser({
      email: 'target@example.com',
      password: 'supersecret',
    });

    await createMembership({
      userId: adminUser.userId,
      projectSlug: 'other-gpt',
      roleCodes: ['admin'],
    });

    const targetMembership = await createMembership({
      userId: targetUser.userId,
      projectSlug: 'other-gpt',
      roleCodes: ['user', 'pro'],
    });

    const response = await app.inject({
      method: 'PUT',
      url: `/projects/other-gpt/memberships/${targetUser.userId}/roles`,
      headers: {
        cookie: adminUser.cookie,
      },
      payload: {
        roleCodes: ['user'],
      },
    });

    expect(response.statusCode).toBe(200);

    const persistedRoles = await app.prisma.projectMembershipRole.findMany({
      where: {
        membershipId: targetMembership.id,
      },
      include: {
        role: true,
      },
      orderBy: {
        role: {
          code: 'asc',
        },
      },
    });

    expect(persistedRoles).toHaveLength(1);
    expect(persistedRoles[0]?.role.code).toBe('user');
  });

  it('rejects role replacement when any role code does not belong to the project', async () => {
    const adminUser = await registerUser({
      email: 'admin@example.com',
      password: 'supersecret',
    });
    const targetUser = await registerUser({
      email: 'target@example.com',
      password: 'supersecret',
    });

    await createMembership({
      userId: adminUser.userId,
      projectSlug: 'cost-console',
      roleCodes: ['admin'],
    });
    await createMembership({
      userId: targetUser.userId,
      projectSlug: 'cost-console',
      roleCodes: ['user'],
    });

    const response = await app.inject({
      method: 'PUT',
      url: `/projects/cost-console/memberships/${targetUser.userId}/roles`,
      headers: {
        cookie: adminUser.cookie,
      },
      payload: {
        roleCodes: ['pro'],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: 'PROJECT_ROLE_CODES_INVALID',
        message: 'One or more project roles do not exist in this project',
      },
    });
  });

  it('keeps authorization scoped to the target project', async () => {
    const adminUser = await registerUser({
      email: 'admin@example.com',
      password: 'supersecret',
    });
    await registerUser({
      email: 'target@example.com',
      password: 'supersecret',
    });

    await createMembership({
      userId: adminUser.userId,
      projectSlug: 'other-gpt',
      roleCodes: ['admin'],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/projects/cost-console/memberships',
      headers: {
        cookie: adminUser.cookie,
      },
      payload: {
        email: 'target@example.com',
        roleCodes: ['user'],
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'PROJECT_ADMIN_REQUIRED',
        message: 'Project admin role required',
      },
    });
  });

  async function clearIdentityData() {
    await app.prisma.projectMembershipRole.deleteMany();
    await app.prisma.projectMembership.deleteMany();
    await app.prisma.session.deleteMany();
    await app.prisma.localCredential.deleteMany();
    await app.prisma.user.deleteMany();
  }

  async function registerUser(input: {
    email: string;
    password: string;
    displayName?: string;
  }): Promise<{ userId: string; cookie: string }> {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: input,
    });

    expect(response.statusCode).toBe(201);

    const parsedResponse = authResponseSchema.parse(response.json());

    return {
      userId: parsedResponse.user.id,
      cookie: extractCookiePair(getRequiredSessionCookie(response)),
    };
  }

  async function createMembership(input: {
    userId: string;
    projectSlug: string;
    roleCodes: string[];
  }) {
    const project = await app.prisma.project.findUniqueOrThrow({
      where: {
        slug: input.projectSlug,
      },
      include: {
        roles: {
          where: {
            code: {
              in: input.roleCodes,
            },
          },
        },
      },
    });

    return app.prisma.projectMembership.create({
      data: {
        userId: input.userId,
        projectId: project.id,
        membershipRoles: {
          create: project.roles.map((role: (typeof project.roles)[number]) => ({
            roleId: role.id,
          })),
        },
      },
    });
  }
});

function getRequiredSessionCookie(response: {
  headers: NodeJS.Dict<number | string | string[]>;
}): string {
  const setCookie = response.headers['set-cookie'];

  if (setCookie === undefined) {
    throw new Error('Expected a set-cookie header');
  }

  if (Array.isArray(setCookie)) {
    return setCookie[0] ?? '';
  }

  return typeof setCookie === 'number' ? String(setCookie) : setCookie;
}

function extractCookiePair(setCookieHeader: string): string {
  return setCookieHeader.split(';', 1)[0] ?? '';
}
