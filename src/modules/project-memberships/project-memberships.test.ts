import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';
import { authResponseSchema } from '../auth/auth.schemas.js';
import { upsertProjectSeedData } from '../identity/bootstrap/project-seed.js';
import {
  projectAccessResponseSchema,
  projectMembershipListResponseSchema,
  projectMembershipResponseSchema,
} from './project-memberships.schemas.js';

describe('project membership routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    app = await buildApp();
    await clearIdentityData();
    await upsertProjectSeedData(app.prisma);
  });

  afterEach(async () => {
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

  it('returns a stable membership list ordered by createdAt desc and id desc for project admins', async () => {
    const adminUser = await registerUser({
      email: 'admin@example.com',
      password: 'supersecret',
      displayName: 'Admin',
    });
    const firstTarget = await registerUser({
      email: 'first@example.com',
      password: 'supersecret',
      displayName: 'First',
    });
    const secondTarget = await registerUser({
      email: 'second@example.com',
      password: 'supersecret',
      displayName: 'Second',
    });
    const thirdTarget = await registerUser({
      email: 'third@example.com',
      password: 'supersecret',
      displayName: 'Third',
    });

    const adminMembership = await createMembership({
      userId: adminUser.userId,
      projectSlug: 'other-gpt',
      roleCodes: ['admin'],
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const latestMembership = await createMembership({
      userId: firstTarget.userId,
      projectSlug: 'other-gpt',
      roleCodes: ['user'],
      createdAt: new Date('2026-01-03T00:00:00.000Z'),
      updatedAt: new Date('2026-01-03T00:00:00.000Z'),
    });
    const sameDateMembershipA = await createMembership({
      userId: secondTarget.userId,
      projectSlug: 'other-gpt',
      roleCodes: ['user'],
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    const sameDateMembershipB = await createMembership({
      userId: thirdTarget.userId,
      projectSlug: 'other-gpt',
      roleCodes: ['pro'],
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/projects/other-gpt/memberships?limit=10',
      headers: {
        cookie: adminUser.cookie,
      },
    });

    expect(response.statusCode).toBe(200);

    const parsedResponse = projectMembershipListResponseSchema.parse(response.json());
    const sameDateExpectedOrder = [sameDateMembershipA.id, sameDateMembershipB.id].sort().reverse();

    expect(parsedResponse.project).toEqual({
      id: expect.any(String),
      slug: 'other-gpt',
      name: 'Other GPT',
    });
    expect(parsedResponse.items.map((item) => item.membershipId)).toEqual([
      latestMembership.id,
      ...sameDateExpectedOrder,
      adminMembership.id,
    ]);
    expect(parsedResponse.page).toEqual({
      nextCursor: null,
      hasMore: false,
      limit: 10,
    });
  });

  it('returns a cursor for the next page and uses it without repeating memberships', async () => {
    const adminUser = await registerUser({
      email: 'admin@example.com',
      password: 'supersecret',
    });
    const firstTarget = await registerUser({
      email: 'first@example.com',
      password: 'supersecret',
    });
    const secondTarget = await registerUser({
      email: 'second@example.com',
      password: 'supersecret',
    });
    const thirdTarget = await registerUser({
      email: 'third@example.com',
      password: 'supersecret',
    });

    const adminMembership = await createMembership({
      userId: adminUser.userId,
      projectSlug: 'other-gpt',
      roleCodes: ['admin'],
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const firstMembership = await createMembership({
      userId: firstTarget.userId,
      projectSlug: 'other-gpt',
      roleCodes: ['user'],
      createdAt: new Date('2026-01-04T00:00:00.000Z'),
      updatedAt: new Date('2026-01-04T00:00:00.000Z'),
    });
    const secondMembership = await createMembership({
      userId: secondTarget.userId,
      projectSlug: 'other-gpt',
      roleCodes: ['user'],
      createdAt: new Date('2026-01-03T00:00:00.000Z'),
      updatedAt: new Date('2026-01-03T00:00:00.000Z'),
    });
    const thirdMembership = await createMembership({
      userId: thirdTarget.userId,
      projectSlug: 'other-gpt',
      roleCodes: ['user'],
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    });

    const firstPageResponse = await app.inject({
      method: 'GET',
      url: '/projects/other-gpt/memberships?limit=2',
      headers: {
        cookie: adminUser.cookie,
      },
    });

    expect(firstPageResponse.statusCode).toBe(200);

    const firstPage = projectMembershipListResponseSchema.parse(firstPageResponse.json());

    expect(firstPage.items.map((item) => item.membershipId)).toEqual([
      firstMembership.id,
      secondMembership.id,
    ]);
    expect(firstPage.page.hasMore).toBe(true);
    expect(firstPage.page.nextCursor).toEqual(expect.any(String));

    const secondPageResponse = await app.inject({
      method: 'GET',
      url: `/projects/other-gpt/memberships?limit=2&cursor=${encodeURIComponent(firstPage.page.nextCursor ?? '')}`,
      headers: {
        cookie: adminUser.cookie,
      },
    });

    expect(secondPageResponse.statusCode).toBe(200);

    const secondPage = projectMembershipListResponseSchema.parse(secondPageResponse.json());

    expect(secondPage.items.map((item) => item.membershipId)).toEqual([
      thirdMembership.id,
      adminMembership.id,
    ]);
    expect(secondPage.page).toEqual({
      nextCursor: null,
      hasMore: false,
      limit: 2,
    });
  });

  it('filters memberships by status', async () => {
    const adminUser = await registerUser({
      email: 'admin@example.com',
      password: 'supersecret',
    });
    const suspendedUser = await registerUser({
      email: 'suspended@example.com',
      password: 'supersecret',
    });
    await registerUser({
      email: 'active@example.com',
      password: 'supersecret',
    });

    await createMembership({
      userId: adminUser.userId,
      projectSlug: 'other-gpt',
      roleCodes: ['admin'],
    });
    const suspendedMembership = await createMembership({
      userId: suspendedUser.userId,
      projectSlug: 'other-gpt',
      roleCodes: ['user'],
      status: 'SUSPENDED',
    });

    await createMembership({
      userId: (
        await app.prisma.user.findUniqueOrThrow({
          where: {
            emailNormalized: 'active@example.com',
          },
          select: {
            id: true,
          },
        })
      ).id,
      projectSlug: 'other-gpt',
      roleCodes: ['user'],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/projects/other-gpt/memberships?status=SUSPENDED',
      headers: {
        cookie: adminUser.cookie,
      },
    });

    expect(response.statusCode).toBe(200);

    const parsedResponse = projectMembershipListResponseSchema.parse(response.json());

    expect(parsedResponse.items).toHaveLength(1);
    expect(parsedResponse.items[0]).toMatchObject({
      membershipId: suspendedMembership.id,
      status: 'SUSPENDED',
      user: {
        email: 'suspended@example.com',
      },
    });
  });

  it('filters memberships by email query', async () => {
    const adminUser = await registerUser({
      email: 'admin@example.com',
      password: 'supersecret',
    });
    await registerUser({
      email: 'alice@example.com',
      password: 'supersecret',
      displayName: 'Alice',
    });
    await registerUser({
      email: 'bob@example.com',
      password: 'supersecret',
      displayName: 'Bob',
    });

    await createMembership({
      userId: adminUser.userId,
      projectSlug: 'other-gpt',
      roleCodes: ['admin'],
    });
    await createMembershipForEmail('alice@example.com', 'other-gpt', ['user']);
    await createMembershipForEmail('bob@example.com', 'other-gpt', ['user']);

    const response = await app.inject({
      method: 'GET',
      url: '/projects/other-gpt/memberships?q=ALICE',
      headers: {
        cookie: adminUser.cookie,
      },
    });

    expect(response.statusCode).toBe(200);

    const parsedResponse = projectMembershipListResponseSchema.parse(response.json());

    expect(parsedResponse.items).toHaveLength(1);
    expect(parsedResponse.items[0]?.user.email).toBe('alice@example.com');
  });

  it('filters memberships by displayName query', async () => {
    const adminUser = await registerUser({
      email: 'admin@example.com',
      password: 'supersecret',
    });
    await registerUser({
      email: 'alice@example.com',
      password: 'supersecret',
      displayName: 'Alice Wonderland',
    });
    await registerUser({
      email: 'bob@example.com',
      password: 'supersecret',
      displayName: 'Bob Builder',
    });

    await createMembership({
      userId: adminUser.userId,
      projectSlug: 'other-gpt',
      roleCodes: ['admin'],
    });
    await createMembershipForEmail('alice@example.com', 'other-gpt', ['user']);
    await createMembershipForEmail('bob@example.com', 'other-gpt', ['user']);

    const response = await app.inject({
      method: 'GET',
      url: '/projects/other-gpt/memberships?q=wonder',
      headers: {
        cookie: adminUser.cookie,
      },
    });

    expect(response.statusCode).toBe(200);

    const parsedResponse = projectMembershipListResponseSchema.parse(response.json());

    expect(parsedResponse.items).toHaveLength(1);
    expect(parsedResponse.items[0]?.user.displayName).toBe('Alice Wonderland');
  });

  it('combines status and search filters', async () => {
    const adminUser = await registerUser({
      email: 'admin@example.com',
      password: 'supersecret',
    });
    await registerUser({
      email: 'alice@example.com',
      password: 'supersecret',
      displayName: 'Alice Cooper',
    });
    await registerUser({
      email: 'alice-active@example.com',
      password: 'supersecret',
      displayName: 'Alice Active',
    });

    await createMembership({
      userId: adminUser.userId,
      projectSlug: 'other-gpt',
      roleCodes: ['admin'],
    });
    const suspendedMembership = await createMembership({
      userId: await getUserIdByEmail('alice@example.com'),
      projectSlug: 'other-gpt',
      roleCodes: ['user'],
      status: 'SUSPENDED',
    });
    await createMembership({
      userId: await getUserIdByEmail('alice-active@example.com'),
      projectSlug: 'other-gpt',
      roleCodes: ['user'],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/projects/other-gpt/memberships?status=SUSPENDED&q=alice',
      headers: {
        cookie: adminUser.cookie,
      },
    });

    expect(response.statusCode).toBe(200);

    const parsedResponse = projectMembershipListResponseSchema.parse(response.json());

    expect(parsedResponse.items).toHaveLength(1);
    expect(parsedResponse.items[0]).toMatchObject({
      membershipId: suspendedMembership.id,
      status: 'SUSPENDED',
      user: {
        email: 'alice@example.com',
      },
    });
  });

  it('returns an empty list when no memberships match the filters', async () => {
    const adminUser = await registerUser({
      email: 'admin@example.com',
      password: 'supersecret',
    });
    await registerUser({
      email: 'person@example.com',
      password: 'supersecret',
    });

    await createMembership({
      userId: adminUser.userId,
      projectSlug: 'other-gpt',
      roleCodes: ['admin'],
    });
    await createMembershipForEmail('person@example.com', 'other-gpt', ['user']);

    const response = await app.inject({
      method: 'GET',
      url: '/projects/other-gpt/memberships?status=REVOKED&q=missing',
      headers: {
        cookie: adminUser.cookie,
      },
    });

    expect(response.statusCode).toBe(200);

    const parsedResponse = projectMembershipListResponseSchema.parse(response.json());

    expect(parsedResponse.items).toEqual([]);
    expect(parsedResponse.page).toEqual({
      nextCursor: null,
      hasMore: false,
      limit: 20,
    });
  });

  it('rejects membership listing when the caller is not a project admin', async () => {
    const caller = await registerUser({
      email: 'person@example.com',
      password: 'supersecret',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/projects/other-gpt/memberships',
      headers: {
        cookie: caller.cookie,
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

  it('keeps membership listing authorization scoped to the target project', async () => {
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
      method: 'GET',
      url: '/projects/cost-console/memberships',
      headers: {
        cookie: adminUser.cookie,
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

  it('returns 404 for membership listing when the project does not exist', async () => {
    const adminUser = await registerUser({
      email: 'admin@example.com',
      password: 'supersecret',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/projects/unknown/memberships',
      headers: {
        cookie: adminUser.cookie,
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

  it('returns 400 when the membership list limit is out of range', async () => {
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
      method: 'GET',
      url: '/projects/other-gpt/memberships?limit=0',
      headers: {
        cookie: adminUser.cookie,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
      },
    });
  });

  it('returns 400 when the membership list cursor is invalid', async () => {
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
      method: 'GET',
      url: '/projects/other-gpt/memberships?cursor=not-a-valid-cursor',
      headers: {
        cookie: adminUser.cookie,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: 'PROJECT_MEMBERSHIP_CURSOR_INVALID',
        message: 'Invalid pagination cursor',
      },
    });
  });

  it('suspends an active membership when another active admin remains', async () => {
    const primaryAdmin = await registerUser({
      email: 'primary-admin@example.com',
      password: 'supersecret',
    });
    const secondaryAdmin = await registerUser({
      email: 'secondary-admin@example.com',
      password: 'supersecret',
    });
    const targetUser = await registerUser({
      email: 'target@example.com',
      password: 'supersecret',
    });

    await createMembership({
      userId: primaryAdmin.userId,
      projectSlug: 'other-gpt',
      roleCodes: ['admin'],
    });
    await createMembership({
      userId: secondaryAdmin.userId,
      projectSlug: 'other-gpt',
      roleCodes: ['admin'],
    });
    const targetMembership = await createMembership({
      userId: targetUser.userId,
      projectSlug: 'other-gpt',
      roleCodes: ['user'],
    });

    const response = await app.inject({
      method: 'POST',
      url: `/projects/other-gpt/memberships/${targetUser.userId}/suspend`,
      headers: {
        cookie: primaryAdmin.cookie,
      },
    });

    expect(response.statusCode).toBe(200);
    const parsedResponse = projectMembershipResponseSchema.parse(response.json());

    expect(parsedResponse).toMatchObject({
      membershipId: expect.any(String),
      status: 'SUSPENDED',
      user: {
        id: targetUser.userId,
        email: 'target@example.com',
      },
    });

    const auditLogs = await listProjectMembershipAuditLogs({
      membershipId: targetMembership.id,
    });

    expect(auditLogs).toEqual([
      expect.objectContaining({
        action: 'SUSPENDED',
        actorUserId: primaryAdmin.userId,
        targetUserId: targetUser.userId,
        fromStatus: 'ACTIVE',
        toStatus: 'SUSPENDED',
        fromRoleCodes: ['user'],
        toRoleCodes: ['user'],
      }),
    ]);
  });

  it('reactivates a suspended membership back to active', async () => {
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
      roleCodes: ['user'],
      status: 'SUSPENDED',
    });

    const response = await app.inject({
      method: 'POST',
      url: `/projects/other-gpt/memberships/${targetUser.userId}/reactivate`,
      headers: {
        cookie: adminUser.cookie,
      },
    });

    expect(response.statusCode).toBe(200);
    const parsedResponse = projectMembershipResponseSchema.parse(response.json());

    expect(parsedResponse).toMatchObject({
      membershipId: expect.any(String),
      status: 'ACTIVE',
      user: {
        id: targetUser.userId,
      },
    });

    const auditLogs = await listProjectMembershipAuditLogs({
      membershipId: targetMembership.id,
    });

    expect(auditLogs).toEqual([
      expect.objectContaining({
        action: 'REACTIVATED',
        actorUserId: adminUser.userId,
        targetUserId: targetUser.userId,
        fromStatus: 'SUSPENDED',
        toStatus: 'ACTIVE',
        fromRoleCodes: ['user'],
        toRoleCodes: ['user'],
      }),
    ]);
  });

  it('revokes an active membership', async () => {
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
      roleCodes: ['user'],
    });

    const response = await app.inject({
      method: 'POST',
      url: `/projects/other-gpt/memberships/${targetUser.userId}/revoke`,
      headers: {
        cookie: adminUser.cookie,
      },
    });

    expect(response.statusCode).toBe(200);
    const parsedResponse = projectMembershipResponseSchema.parse(response.json());

    expect(parsedResponse).toMatchObject({
      membershipId: expect.any(String),
      status: 'REVOKED',
      user: {
        id: targetUser.userId,
      },
    });

    const auditLogs = await listProjectMembershipAuditLogs({
      membershipId: targetMembership.id,
    });

    expect(auditLogs).toEqual([
      expect.objectContaining({
        action: 'REVOKED',
        actorUserId: adminUser.userId,
        targetUserId: targetUser.userId,
        fromStatus: 'ACTIVE',
        toStatus: 'REVOKED',
        fromRoleCodes: ['user'],
        toRoleCodes: ['user'],
      }),
    ]);
  });

  it('revokes a suspended membership', async () => {
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
      roleCodes: ['user'],
      status: 'SUSPENDED',
    });

    const response = await app.inject({
      method: 'POST',
      url: `/projects/other-gpt/memberships/${targetUser.userId}/revoke`,
      headers: {
        cookie: adminUser.cookie,
      },
    });

    expect(response.statusCode).toBe(200);
    const parsedResponse = projectMembershipResponseSchema.parse(response.json());

    expect(parsedResponse).toMatchObject({
      membershipId: expect.any(String),
      status: 'REVOKED',
      user: {
        id: targetUser.userId,
      },
    });

    const auditLogs = await listProjectMembershipAuditLogs({
      membershipId: targetMembership.id,
    });

    expect(auditLogs).toEqual([
      expect.objectContaining({
        action: 'REVOKED',
        actorUserId: adminUser.userId,
        targetUserId: targetUser.userId,
        fromStatus: 'SUSPENDED',
        toStatus: 'REVOKED',
        fromRoleCodes: ['user'],
        toRoleCodes: ['user'],
      }),
    ]);
  });

  it('rejects reactivation for a revoked membership', async () => {
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
      status: 'REVOKED',
    });

    const response = await app.inject({
      method: 'POST',
      url: `/projects/other-gpt/memberships/${targetUser.userId}/reactivate`,
      headers: {
        cookie: adminUser.cookie,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: 'PROJECT_MEMBERSHIP_STATUS_TRANSITION_INVALID',
        message: 'Cannot reactivate membership from REVOKED status',
      },
    });

    expect(
      await listProjectMembershipAuditLogs({
        targetUserId: targetUser.userId,
      }),
    ).toEqual([]);
  });

  it('rejects suspension for a suspended membership', async () => {
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
      status: 'SUSPENDED',
    });

    const response = await app.inject({
      method: 'POST',
      url: `/projects/other-gpt/memberships/${targetUser.userId}/suspend`,
      headers: {
        cookie: adminUser.cookie,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: 'PROJECT_MEMBERSHIP_STATUS_TRANSITION_INVALID',
        message: 'Cannot suspend membership from SUSPENDED status',
      },
    });
  });

  it('rejects revocation for a revoked membership', async () => {
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
      status: 'REVOKED',
    });

    const response = await app.inject({
      method: 'POST',
      url: `/projects/other-gpt/memberships/${targetUser.userId}/revoke`,
      headers: {
        cookie: adminUser.cookie,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: 'PROJECT_MEMBERSHIP_STATUS_TRANSITION_INVALID',
        message: 'Cannot revoke membership from REVOKED status',
      },
    });
  });

  it('keeps revoked memberships non-readmittable through membership creation', async () => {
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
      status: 'REVOKED',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/projects/other-gpt/memberships',
      headers: {
        cookie: adminUser.cookie,
      },
      payload: {
        email: 'target@example.com',
        roleCodes: ['user'],
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

  it('prevents suspending the last active admin in a project', async () => {
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
      url: `/projects/other-gpt/memberships/${adminUser.userId}/suspend`,
      headers: {
        cookie: adminUser.cookie,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: 'PROJECT_LAST_ACTIVE_ADMIN_REQUIRED',
        message: 'At least one active project admin is required',
      },
    });

    expect(
      await listProjectMembershipAuditLogs({
        targetUserId: adminUser.userId,
      }),
    ).toEqual([]);
  });

  it('prevents revoking the last active admin in a project', async () => {
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
      url: `/projects/other-gpt/memberships/${adminUser.userId}/revoke`,
      headers: {
        cookie: adminUser.cookie,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: 'PROJECT_LAST_ACTIVE_ADMIN_REQUIRED',
        message: 'At least one active project admin is required',
      },
    });
  });

  it('prevents removing the admin role from the last active admin', async () => {
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
      method: 'PUT',
      url: `/projects/other-gpt/memberships/${adminUser.userId}/roles`,
      headers: {
        cookie: adminUser.cookie,
      },
      payload: {
        roleCodes: ['user'],
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: 'PROJECT_LAST_ACTIVE_ADMIN_REQUIRED',
        message: 'At least one active project admin is required',
      },
    });
  });

  it('allows removing admin from one membership when another active admin remains', async () => {
    const primaryAdmin = await registerUser({
      email: 'primary-admin@example.com',
      password: 'supersecret',
    });
    const secondaryAdmin = await registerUser({
      email: 'secondary-admin@example.com',
      password: 'supersecret',
    });

    await createMembership({
      userId: primaryAdmin.userId,
      projectSlug: 'other-gpt',
      roleCodes: ['admin'],
    });
    await createMembership({
      userId: secondaryAdmin.userId,
      projectSlug: 'other-gpt',
      roleCodes: ['admin'],
    });

    const response = await app.inject({
      method: 'PUT',
      url: `/projects/other-gpt/memberships/${secondaryAdmin.userId}/roles`,
      headers: {
        cookie: primaryAdmin.cookie,
      },
      payload: {
        roleCodes: ['user'],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(projectMembershipResponseSchema.parse(response.json())).toMatchObject({
      membershipId: expect.any(String),
      status: 'ACTIVE',
      user: {
        id: secondaryAdmin.userId,
      },
      roles: [
        {
          code: 'user',
          name: 'User',
        },
      ],
    });
  });

  it('blocks project-scoped membership endpoints when the project is disabled', async () => {
    const adminUser = await registerUser({
      email: 'admin@example.com',
      password: 'supersecret',
    });
    const targetUser = await registerUser({
      email: 'target@example.com',
      password: 'supersecret',
    });
    await registerUser({
      email: 'new-target@example.com',
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
      status: 'SUSPENDED',
    });
    await disableProject('other-gpt');

    const requests = [
      { method: 'GET', url: '/projects/other-gpt/me' },
      { method: 'GET', url: '/projects/other-gpt/memberships' },
      {
        method: 'POST',
        url: '/projects/other-gpt/memberships',
        payload: {
          email: 'new-target@example.com',
          roleCodes: ['user'],
        },
      },
      {
        method: 'PUT',
        url: `/projects/other-gpt/memberships/${targetUser.userId}/roles`,
        payload: {
          roleCodes: ['user'],
        },
      },
      {
        method: 'POST',
        url: `/projects/other-gpt/memberships/${targetUser.userId}/suspend`,
      },
      {
        method: 'POST',
        url: `/projects/other-gpt/memberships/${targetUser.userId}/reactivate`,
      },
      {
        method: 'POST',
        url: `/projects/other-gpt/memberships/${targetUser.userId}/revoke`,
      },
    ] as const;

    for (const request of requests) {
      const response = await app.inject({
        method: request.method,
        url: request.url,
        headers: {
          cookie: adminUser.cookie,
        },
        payload: 'payload' in request ? request.payload : undefined,
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: {
          code: 'PROJECT_DISABLED',
          message: 'Project is disabled',
        },
      });
    }

    expect(
      await listProjectMembershipAuditLogs({
        targetUserId: targetUser.userId,
      }),
    ).toEqual([]);
  });

  it('keeps auth me unchanged when a project is disabled', async () => {
    const adminUser = await registerUser({
      email: 'admin@example.com',
      password: 'supersecret',
    });

    await createMembership({
      userId: adminUser.userId,
      projectSlug: 'other-gpt',
      roleCodes: ['admin', 'pro'],
    });
    await disableProject('other-gpt');

    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: {
        cookie: adminUser.cookie,
      },
    });

    expect(response.statusCode).toBe(200);

    const parsedResponse = authResponseSchema.parse(response.json());

    expect(parsedResponse.user.memberships).toHaveLength(1);
    expect(parsedResponse.user.memberships[0]).toMatchObject({
      id: expect.any(String),
      status: 'ACTIVE',
      project: {
        slug: 'other-gpt',
        name: 'Other GPT',
      },
      roles: [
        {
          code: 'admin',
          name: 'Admin',
        },
        {
          code: 'pro',
          name: 'Pro',
        },
      ],
    });
  });

  it('persists structured membership audit rows in createdAt order', async () => {
    const actorUser = await registerUser({
      email: 'actor@example.com',
      password: 'supersecret',
    });
    const targetUser = await registerUser({
      email: 'target@example.com',
      password: 'supersecret',
    });
    const project = await app.prisma.project.findUniqueOrThrow({
      where: {
        slug: 'other-gpt',
      },
      select: {
        id: true,
      },
    });
    const membership = await createMembership({
      userId: targetUser.userId,
      projectSlug: 'other-gpt',
      roleCodes: ['user'],
    });

    await app.prisma.projectMembershipAuditLog.createMany({
      data: [
        {
          action: 'CREATED',
          projectId: project.id,
          membershipId: membership.id,
          actorUserId: actorUser.userId,
          targetUserId: targetUser.userId,
          fromStatus: null,
          toStatus: 'ACTIVE',
          fromRoleCodes: [],
          toRoleCodes: ['user'],
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          action: 'ROLES_REPLACED',
          projectId: project.id,
          membershipId: membership.id,
          actorUserId: actorUser.userId,
          targetUserId: targetUser.userId,
          fromStatus: 'ACTIVE',
          toStatus: 'ACTIVE',
          fromRoleCodes: ['user'],
          toRoleCodes: ['admin'],
          createdAt: new Date('2026-01-02T00:00:00.000Z'),
        },
      ],
    });

    const auditLogs = await listProjectMembershipAuditLogs({
      membershipId: membership.id,
    });

    expect(auditLogs).toHaveLength(2);
    expect(auditLogs.map((auditLog) => auditLog.action)).toEqual(['CREATED', 'ROLES_REPLACED']);
    expect(auditLogs[0]).toMatchObject({
      fromStatus: null,
      toStatus: 'ACTIVE',
      fromRoleCodes: [],
      toRoleCodes: ['user'],
    });
    expect(auditLogs[1]).toMatchObject({
      fromStatus: 'ACTIVE',
      toStatus: 'ACTIVE',
      fromRoleCodes: ['user'],
      toRoleCodes: ['admin'],
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
    const parsedResponse = projectMembershipResponseSchema.parse(response.json());

    expect(parsedResponse).toEqual({
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

    const auditLogs = await listProjectMembershipAuditLogs({
      membershipId: parsedResponse.membershipId,
    });

    expect(auditLogs).toEqual([
      expect.objectContaining({
        action: 'CREATED',
        actorUserId: adminUser.userId,
        targetUserId: targetUser.userId,
        fromStatus: null,
        toStatus: 'ACTIVE',
        fromRoleCodes: [],
        toRoleCodes: ['pro', 'user'],
      }),
    ]);
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

    expect(
      await listProjectMembershipAuditLogs({
        targetUserId: targetUser.userId,
      }),
    ).toEqual([]);
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
        roleCodes: ['admin'],
      },
    });

    expect(response.statusCode).toBe(200);
    const parsedResponse = projectMembershipResponseSchema.parse(response.json());

    expect(parsedResponse).toEqual({
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

    const auditLogs = await listProjectMembershipAuditLogs({
      membershipId: targetMembership.id,
    });

    expect(auditLogs).toEqual([
      expect.objectContaining({
        action: 'ROLES_REPLACED',
        actorUserId: adminUser.userId,
        targetUserId: targetUser.userId,
        fromStatus: 'ACTIVE',
        toStatus: 'ACTIVE',
        fromRoleCodes: ['pro', 'user'],
        toRoleCodes: ['admin'],
      }),
    ]);
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
    status?: 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
    createdAt?: Date;
    updatedAt?: Date;
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

    const membership = await app.prisma.projectMembership.create({
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

    if (
      input.status === undefined &&
      input.createdAt === undefined &&
      input.updatedAt === undefined
    ) {
      return membership;
    }

    return app.prisma.projectMembership.update({
      where: {
        id: membership.id,
      },
      data: {
        status: input.status,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      },
    });
  }

  async function createMembershipForEmail(
    email: string,
    projectSlug: string,
    roleCodes: string[],
    overrides?: {
      status?: 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
      createdAt?: Date;
      updatedAt?: Date;
    },
  ) {
    return createMembership({
      userId: await getUserIdByEmail(email),
      projectSlug,
      roleCodes,
      ...overrides,
    });
  }

  async function getUserIdByEmail(email: string) {
    const user = await app.prisma.user.findUniqueOrThrow({
      where: {
        emailNormalized: email.toLowerCase(),
      },
      select: {
        id: true,
      },
    });

    return user.id;
  }

  async function disableProject(projectSlug: string) {
    await app.prisma.project.update({
      where: {
        slug: projectSlug,
      },
      data: {
        status: 'DISABLED',
      },
    });
  }

  async function listProjectMembershipAuditLogs(input?: {
    membershipId?: string;
    targetUserId?: string;
    action?: 'CREATED' | 'ROLES_REPLACED' | 'SUSPENDED' | 'REACTIVATED' | 'REVOKED';
  }) {
    return app.prisma.projectMembershipAuditLog.findMany({
      where: {
        membershipId: input?.membershipId,
        targetUserId: input?.targetUserId,
        action: input?.action,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
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
