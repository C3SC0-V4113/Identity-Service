import argon2 from 'argon2';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';
import { hashSessionToken } from '../../shared/auth/session-auth.js';
import { upsertProjectSeedData } from '../identity/bootstrap/project-seed.js';
import {
  projectAuthResponseSchema,
  projectSessionListResponseSchema,
  registerEmailCheckResponseSchema,
} from './auth.schemas.js';
import { getSessionCookieName } from './auth.cookies.js';

describe('auth routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
  });

  beforeEach(async () => {
    await clearAuthData();
    await upsertProjectSeedData(app.prisma);
  });

  afterAll(async () => {
    await clearAuthData();
    await app.close();
  });

  it('checks registration email for a new ecosystem user', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/projects/other-gpt/auth/register/email-check',
      payload: {
        email: '  person@example.com ',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(registerEmailCheckResponseSchema.parse(response.json())).toEqual({
      email: 'person@example.com',
      exists: false,
      nextStep: 'REGISTER',
    });
  });

  it('checks registration email for an existing ecosystem user', async () => {
    await createUser({
      email: 'person@example.com',
      password: 'supersecret',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/projects/other-gpt/auth/register/email-check',
      payload: {
        email: 'PERSON@example.com',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(registerEmailCheckResponseSchema.parse(response.json())).toEqual({
      email: 'PERSON@example.com',
      exists: true,
      nextStep: 'LOGIN',
    });
  });

  it('registers a new user into a project with the default role and a project session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/projects/other-gpt/auth/register',
      payload: {
        email: '  Person@Example.com ',
        password: 'supersecret',
        displayName: '  Person  ',
      },
    });

    expect(response.statusCode).toBe(201);
    const parsedResponse = projectAuthResponseSchema.parse(response.json());
    expect(parsedResponse.user.id).toEqual(expect.any(String));
    expect(parsedResponse.user.email).toBe('Person@Example.com');
    expect(parsedResponse.user.displayName).toBe('Person');
    expect(parsedResponse.project).toEqual({
      id: expect.any(String),
      slug: 'other-gpt',
      name: 'Other GPT',
    });
    expect(parsedResponse.membership).toEqual({
      id: expect.any(String),
      status: 'ACTIVE',
      roles: [
        {
          id: expect.any(String),
          code: 'user',
          name: 'User',
        },
      ],
    });

    const sessionCookie = getRequiredSessionCookie(response);
    const sessionToken = extractCookieValue(sessionCookie);
    const createdUser = await app.prisma.user.findUniqueOrThrow({
      where: {
        emailNormalized: 'person@example.com',
      },
      include: {
        localCredential: true,
        sessions: true,
        memberships: {
          include: {
            membershipRoles: {
              include: {
                role: true,
              },
            },
            project: true,
          },
        },
      },
    });

    expect(createdUser.localCredential).not.toBeNull();
    expect(createdUser.sessions).toHaveLength(1);
    expect(createdUser.sessions[0]?.secretHash).toHaveLength(64);
    expect(createdUser.sessions[0]?.secretHash).not.toBe(sessionToken);
    expect(createdUser.sessions[0]?.projectId).toBe(createdUser.memberships[0]?.projectId);
    expect(createdUser.memberships).toHaveLength(1);
    expect(createdUser.memberships[0]?.project.slug).toBe('other-gpt');
    expect(createdUser.memberships[0]?.membershipRoles.map((item) => item.role.code)).toEqual([
      'user',
    ]);
    expect(sessionCookie).toContain(`${getSessionCookieName()}=`);
    expect(sessionCookie).toContain('HttpOnly');
  });

  it('rejects project registration when the email is already registered globally', async () => {
    await registerViaApi('other-gpt', {
      email: 'person@example.com',
      password: 'supersecret',
    });

    const duplicateResponse = await app.inject({
      method: 'POST',
      url: '/projects/cost-console/auth/register',
      payload: {
        email: 'PERSON@example.com',
        password: 'supersecret',
      },
    });

    expect(duplicateResponse.statusCode).toBe(409);
    expect(duplicateResponse.json()).toEqual({
      error: {
        code: 'EMAIL_ALREADY_EXISTS',
        message: 'Email address is already registered',
      },
    });
  });

  it('logs in with valid credentials and creates a project membership when missing', async () => {
    const user = await createUser({
      email: 'person@example.com',
      password: 'supersecret',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/projects/other-gpt/auth/login',
      payload: {
        email: 'PERSON@example.com',
        password: 'supersecret',
      },
    });

    expect(response.statusCode).toBe(200);
    const parsedResponse = projectAuthResponseSchema.parse(response.json());
    expect(parsedResponse.user.email).toBe('person@example.com');
    expect(parsedResponse.project.slug).toBe('other-gpt');
    expect(parsedResponse.membership?.roles.map((role) => role.code)).toEqual(['user']);

    const persistedMembership = await app.prisma.projectMembership.findUniqueOrThrow({
      where: {
        projectId_userId: {
          projectId: await getProjectId('other-gpt'),
          userId: user.id,
        },
      },
      include: {
        membershipRoles: {
          include: {
            role: true,
          },
        },
      },
    });

    expect(persistedMembership.status).toBe('ACTIVE');
    expect(persistedMembership.membershipRoles.map((item) => item.role.code)).toEqual(['user']);

    const persistedSessions = await app.prisma.session.findMany({
      where: {
        userId: user.id,
      },
    });
    expect(persistedSessions).toHaveLength(1);
    expect(persistedSessions[0]?.projectId).toBe(await getProjectId('other-gpt'));
  });

  it('logs in with valid credentials when the project membership already exists', async () => {
    const user = await createUser({
      email: 'person@example.com',
      password: 'supersecret',
    });
    await createMembership({
      userId: user.id,
      projectSlug: 'other-gpt',
      roleCodes: ['pro', 'user'],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/projects/other-gpt/auth/login',
      payload: {
        email: 'person@example.com',
        password: 'supersecret',
      },
    });

    expect(response.statusCode).toBe(200);
    const parsedResponse = projectAuthResponseSchema.parse(response.json());
    expect(parsedResponse.membership?.roles.map((role) => role.code)).toEqual(['pro', 'user']);
  });

  it('rejects login with an invalid password', async () => {
    await createUser({
      email: 'person@example.com',
      password: 'supersecret',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/projects/other-gpt/auth/login',
      payload: {
        email: 'person@example.com',
        password: 'wrong-password',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      },
    });
  });

  it('rejects login for a banned user', async () => {
    const user = await createUser({
      email: 'person@example.com',
      password: 'supersecret',
    });

    await app.prisma.user.update({
      where: {
        id: user.id,
      },
      data: {
        status: 'BANNED',
        bannedAt: new Date(),
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/projects/other-gpt/auth/login',
      payload: {
        email: 'person@example.com',
        password: 'supersecret',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'USER_BANNED',
        message: 'User is banned',
      },
    });
  });

  it('rejects login when the project membership is suspended', async () => {
    const user = await createUser({
      email: 'person@example.com',
      password: 'supersecret',
    });
    await createMembership({
      userId: user.id,
      projectSlug: 'other-gpt',
      roleCodes: ['user'],
      status: 'SUSPENDED',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/projects/other-gpt/auth/login',
      payload: {
        email: 'person@example.com',
        password: 'supersecret',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'PROJECT_MEMBERSHIP_SUSPENDED',
        message: 'Project membership is suspended',
      },
    });
  });

  it('rejects login when the project membership is revoked', async () => {
    const user = await createUser({
      email: 'person@example.com',
      password: 'supersecret',
    });
    await createMembership({
      userId: user.id,
      projectSlug: 'other-gpt',
      roleCodes: ['user'],
      status: 'REVOKED',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/projects/other-gpt/auth/login',
      payload: {
        email: 'person@example.com',
        password: 'supersecret',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'PROJECT_MEMBERSHIP_REVOKED',
        message: 'Project membership is revoked',
      },
    });
  });

  it('revokes only the current project session on logout', async () => {
    const firstProjectCookie = await registerViaApi('other-gpt', {
      email: 'person@example.com',
      password: 'supersecret',
    });
    const secondProjectCookie = await loginViaApi('cost-console', {
      email: 'person@example.com',
      password: 'supersecret',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/projects/other-gpt/auth/logout',
      headers: {
        cookie: firstProjectCookie,
      },
    });

    expect(response.statusCode).toBe(204);

    const otherGptSession = await app.prisma.session.findFirstOrThrow({
      where: {
        projectId: await getProjectId('other-gpt'),
      },
    });
    expect(otherGptSession.status).toBe('REVOKED');
    expect(otherGptSession.revokedReason).toBe('USER_LOGOUT');

    const costConsoleMe = await app.inject({
      method: 'GET',
      url: '/projects/cost-console/auth/me',
      headers: {
        cookie: secondProjectCookie,
      },
    });
    expect(costConsoleMe.statusCode).toBe(200);
  });

  it('returns the authenticated profile scoped to the current project and updates lastSeenAt', async () => {
    const registerResponse = await app.inject({
      method: 'POST',
      url: '/projects/other-gpt/auth/register',
      payload: {
        email: 'person@example.com',
        password: 'supersecret',
        displayName: 'Person',
      },
    });

    const parsedRegisterResponse = projectAuthResponseSchema.parse(registerResponse.json());
    const userId = parsedRegisterResponse.user.id;
    await setMembershipRoles(userId, 'other-gpt', ['pro', 'user']);
    await loginViaApi('cost-console', {
      email: 'person@example.com',
      password: 'supersecret',
    });

    const sessionBeforeMe = await app.prisma.session.findFirstOrThrow({
      where: {
        userId,
        projectId: await getProjectId('other-gpt'),
      },
    });

    expect(sessionBeforeMe.lastSeenAt).toBeNull();

    const meResponse = await app.inject({
      method: 'GET',
      url: '/projects/other-gpt/auth/me',
      headers: {
        cookie: extractCookiePair(getRequiredSessionCookie(registerResponse)),
      },
    });

    expect(meResponse.statusCode).toBe(200);
    const parsedMeResponse = projectAuthResponseSchema.parse(meResponse.json());
    expect(parsedMeResponse.user.id).toBe(userId);
    expect(parsedMeResponse.user.email).toBe('person@example.com');
    expect(parsedMeResponse.user.displayName).toBe('Person');
    expect(parsedMeResponse.project).toEqual({
      id: expect.any(String),
      slug: 'other-gpt',
      name: 'Other GPT',
    });
    expect(parsedMeResponse.membership).toEqual({
      id: expect.any(String),
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

    const sessionAfterMe = await app.prisma.session.findFirstOrThrow({
      where: {
        userId,
        projectId: await getProjectId('other-gpt'),
      },
    });

    expect(sessionAfterMe.lastSeenAt).not.toBeNull();
  });

  it('validates the current project session with 204 for client middleware checks', async () => {
    const cookie = await registerViaApi('other-gpt', {
      email: 'person@example.com',
      password: 'supersecret',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/projects/other-gpt/auth/session',
      headers: {
        cookie,
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
  });

  it('does not update lastSeenAt when validating the current session', async () => {
    const registerResponse = await app.inject({
      method: 'POST',
      url: '/projects/other-gpt/auth/register',
      payload: {
        email: 'person@example.com',
        password: 'supersecret',
      },
    });

    const cookie = extractCookiePair(getRequiredSessionCookie(registerResponse));
    const userId = projectAuthResponseSchema.parse(registerResponse.json()).user.id;
    const sessionBeforeValidation = await app.prisma.session.findFirstOrThrow({
      where: {
        userId,
        projectId: await getProjectId('other-gpt'),
      },
    });

    expect(sessionBeforeValidation.lastSeenAt).toBeNull();

    const response = await app.inject({
      method: 'GET',
      url: '/projects/other-gpt/auth/session',
      headers: {
        cookie,
      },
    });

    expect(response.statusCode).toBe(204);

    const sessionAfterValidation = await app.prisma.session.findFirstOrThrow({
      where: {
        userId,
        projectId: await getProjectId('other-gpt'),
      },
    });

    expect(sessionAfterValidation.lastSeenAt).toBeNull();
  });

  it('rejects auth me when no session cookie is present', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/projects/other-gpt/auth/me',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication required',
      },
    });
  });

  it('rejects auth session when no session cookie is present', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/projects/other-gpt/auth/session',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication required',
      },
    });
  });

  it('rejects auth session when the session has been revoked', async () => {
    const cookie = await registerViaApi('other-gpt', {
      email: 'person@example.com',
      password: 'supersecret',
    });
    const sessionId = await findCurrentProjectSessionId('other-gpt', cookie);

    await app.prisma.session.update({
      where: {
        id: sessionId,
      },
      data: {
        status: 'REVOKED',
        revokedAt: new Date(),
        revokedReason: 'TEST_REVOKED',
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/projects/other-gpt/auth/session',
      headers: {
        cookie,
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication required',
      },
    });
  });

  it('rejects auth session when the session has expired', async () => {
    const cookie = await registerViaApi('other-gpt', {
      email: 'person@example.com',
      password: 'supersecret',
    });
    const sessionId = await findCurrentProjectSessionId('other-gpt', cookie);

    await app.prisma.session.update({
      where: {
        id: sessionId,
      },
      data: {
        expiresAt: new Date(Date.now() - 1_000),
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/projects/other-gpt/auth/session',
      headers: {
        cookie,
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication required',
      },
    });

    const persistedSession = await app.prisma.session.findUniqueOrThrow({
      where: {
        id: sessionId,
      },
    });
    expect(persistedSession.status).toBe('EXPIRED');
  });

  it('rejects auth me when the session belongs to a different project', async () => {
    const cookie = await registerViaApi('other-gpt', {
      email: 'person@example.com',
      password: 'supersecret',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/projects/cost-console/auth/me',
      headers: {
        cookie,
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects auth session when the session belongs to a different project', async () => {
    const cookie = await registerViaApi('other-gpt', {
      email: 'person@example.com',
      password: 'supersecret',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/projects/cost-console/auth/session',
      headers: {
        cookie,
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication required',
      },
    });
  });

  it('rejects auth me when the project is disabled', async () => {
    const cookie = await registerViaApi('other-gpt', {
      email: 'person@example.com',
      password: 'supersecret',
    });
    await disableProject('other-gpt');

    const response = await app.inject({
      method: 'GET',
      url: '/projects/other-gpt/auth/me',
      headers: {
        cookie,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'PROJECT_DISABLED',
        message: 'Project is disabled',
      },
    });
  });

  it('rejects auth session when the project is disabled', async () => {
    const cookie = await registerViaApi('other-gpt', {
      email: 'person@example.com',
      password: 'supersecret',
    });
    await disableProject('other-gpt');

    const response = await app.inject({
      method: 'GET',
      url: '/projects/other-gpt/auth/session',
      headers: {
        cookie,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'PROJECT_DISABLED',
        message: 'Project is disabled',
      },
    });
  });

  it('rejects auth session when the user is banned', async () => {
    const registerResponse = await app.inject({
      method: 'POST',
      url: '/projects/other-gpt/auth/register',
      payload: {
        email: 'person@example.com',
        password: 'supersecret',
      },
    });

    const cookie = extractCookiePair(getRequiredSessionCookie(registerResponse));
    const userId = projectAuthResponseSchema.parse(registerResponse.json()).user.id;

    await app.prisma.user.update({
      where: {
        id: userId,
      },
      data: {
        status: 'BANNED',
        bannedAt: new Date(),
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/projects/other-gpt/auth/session',
      headers: {
        cookie,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: 'USER_BANNED',
        message: 'User is banned',
      },
    });
  });

  it('rejects admin session endpoints without a session', async () => {
    const list = await app.inject({ method: 'GET', url: '/projects/other-gpt/sessions' });
    expect(list.statusCode).toBe(401);

    const revoke = await app.inject({
      method: 'POST',
      url: '/projects/other-gpt/sessions/some-id/revoke',
    });
    expect(revoke.statusCode).toBe(401);
  });

  it('lists only the target project sessions for a project admin', async () => {
    const adminCookie = await registerViaApi('other-gpt', {
      email: 'admin@example.com',
      password: 'supersecret',
    });
    const targetCookie = await registerViaApi('other-gpt', {
      email: 'member@example.com',
      password: 'supersecret',
    });
    await setMembershipRolesByEmail('admin@example.com', 'other-gpt', ['admin']);
    await loginViaApi('cost-console', {
      email: 'member@example.com',
      password: 'supersecret',
    });
    await app.prisma.session.updateMany({
      where: {
        projectId: await getProjectId('other-gpt'),
      },
      data: {
        lastSeenAt: new Date('2026-05-31T12:00:00.000Z'),
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/projects/other-gpt/sessions?limit=10',
      headers: {
        cookie: adminCookie,
      },
    });

    expect(response.statusCode).toBe(200);
    const parsed = projectSessionListResponseSchema.parse(response.json());
    expect(parsed.project.slug).toBe('other-gpt');
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.map((session) => session.user.email).sort()).toEqual([
      'admin@example.com',
      'member@example.com',
    ]);

    const currentProjectIds = await app.prisma.session.findMany({
      where: {
        id: {
          in: parsed.items.map((item) => item.id),
        },
      },
      select: {
        projectId: true,
      },
    });

    expect(new Set(currentProjectIds.map((item) => item.projectId))).toEqual(
      new Set([await getProjectId('other-gpt')]),
    );
    expect(targetCookie).toContain(`${getSessionCookieName()}=`);
  });

  it('supports filtering project sessions by status', async () => {
    const adminCookie = await registerViaApi('other-gpt', {
      email: 'admin@example.com',
      password: 'supersecret',
    });
    await setMembershipRolesByEmail('admin@example.com', 'other-gpt', ['admin']);
    const memberCookie = await registerViaApi('other-gpt', {
      email: 'member@example.com',
      password: 'supersecret',
    });
    const memberSessionId = await findCurrentProjectSessionId('other-gpt', memberCookie);

    await app.prisma.session.update({
      where: {
        id: memberSessionId,
      },
      data: {
        status: 'REVOKED',
        revokedAt: new Date(),
        revokedReason: 'TEST_REVOKED',
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/projects/other-gpt/sessions?status=REVOKED',
      headers: {
        cookie: adminCookie,
      },
    });

    expect(response.statusCode).toBe(200);
    const parsed = projectSessionListResponseSchema.parse(response.json());
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.id).toBe(memberSessionId);
    expect(parsed.items[0]?.status).toBe('REVOKED');
  });

  it('does not allow non-admin users to list project sessions', async () => {
    const userCookie = await registerViaApi('other-gpt', {
      email: 'person@example.com',
      password: 'supersecret',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/projects/other-gpt/sessions',
      headers: {
        cookie: userCookie,
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

  it('allows a project admin to revoke another session from the same project', async () => {
    const adminCookie = await registerViaApi('other-gpt', {
      email: 'admin@example.com',
      password: 'supersecret',
    });
    await setMembershipRolesByEmail('admin@example.com', 'other-gpt', ['admin']);
    const targetCookie = await registerViaApi('other-gpt', {
      email: 'member@example.com',
      password: 'supersecret',
    });
    const targetSessionId = await findCurrentProjectSessionId('other-gpt', targetCookie);

    const revoke = await app.inject({
      method: 'POST',
      url: `/projects/other-gpt/sessions/${targetSessionId}/revoke`,
      headers: {
        cookie: adminCookie,
      },
    });

    expect(revoke.statusCode).toBe(204);

    const revokedUse = await app.inject({
      method: 'GET',
      url: '/projects/other-gpt/auth/me',
      headers: {
        cookie: targetCookie,
      },
    });
    expect(revokedUse.statusCode).toBe(401);
  });

  it('returns 404 when revoking an unknown project session id', async () => {
    const adminCookie = await registerViaApi('other-gpt', {
      email: 'admin@example.com',
      password: 'supersecret',
    });
    await setMembershipRolesByEmail('admin@example.com', 'other-gpt', ['admin']);

    const response = await app.inject({
      method: 'POST',
      url: '/projects/other-gpt/sessions/does-not-exist/revoke',
      headers: {
        cookie: adminCookie,
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: 'SESSION_NOT_FOUND',
        message: 'Session not found',
      },
    });
  });

  it('does not allow an admin to revoke a session from another project', async () => {
    const adminCookie = await registerViaApi('other-gpt', {
      email: 'admin@example.com',
      password: 'supersecret',
    });
    await setMembershipRolesByEmail('admin@example.com', 'other-gpt', ['admin']);
    await registerViaApi('cost-console', {
      email: 'member@example.com',
      password: 'supersecret',
    });
    const foreignSessionId = await findCurrentProjectSessionId(
      'cost-console',
      await loginViaApi('cost-console', {
        email: 'member@example.com',
        password: 'supersecret',
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: `/projects/other-gpt/sessions/${foreignSessionId}/revoke`,
      headers: {
        cookie: adminCookie,
      },
    });

    expect(response.statusCode).toBe(404);
  });

  async function clearAuthData() {
    await app.prisma.projectMembershipRole.deleteMany();
    await app.prisma.projectMembership.deleteMany();
    await app.prisma.session.deleteMany();
    await app.prisma.localCredential.deleteMany();
    await app.prisma.user.deleteMany();
  }

  async function registerViaApi(
    projectSlug: string,
    input: { email: string; password: string; displayName?: string },
  ): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectSlug}/auth/register`,
      payload: input,
    });

    expect(response.statusCode).toBe(201);

    return extractCookiePair(getRequiredSessionCookie(response));
  }

  async function loginViaApi(
    projectSlug: string,
    input: { email: string; password: string },
  ): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectSlug}/auth/login`,
      payload: input,
    });

    expect(response.statusCode).toBe(200);

    return extractCookiePair(getRequiredSessionCookie(response));
  }

  async function createUser(input: { email: string; password: string; displayName?: string }) {
    const passwordHash = await argon2.hash(input.password);

    return app.prisma.user.create({
      data: {
        email: input.email,
        emailNormalized: input.email.toLowerCase(),
        displayName: input.displayName ?? null,
        localCredential: {
          create: {
            passwordHash,
          },
        },
      },
    });
  }

  async function createMembership(input: {
    userId: string;
    projectSlug: string;
    roleCodes: string[];
    status?: 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
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
        status: input.status ?? 'ACTIVE',
        membershipRoles: {
          create: project.roles.map((role) => ({
            roleId: role.id,
          })),
        },
      },
    });

    return membership;
  }

  async function setMembershipRoles(userId: string, projectSlug: string, roleCodes: string[]) {
    const project = await app.prisma.project.findUniqueOrThrow({
      where: {
        slug: projectSlug,
      },
      include: {
        roles: {
          where: {
            code: {
              in: roleCodes,
            },
          },
        },
      },
    });
    const membership = await app.prisma.projectMembership.findUniqueOrThrow({
      where: {
        projectId_userId: {
          projectId: project.id,
          userId,
        },
      },
    });

    await app.prisma.projectMembershipRole.deleteMany({
      where: {
        membershipId: membership.id,
      },
    });
    await app.prisma.projectMembershipRole.createMany({
      data: project.roles.map((role) => ({
        membershipId: membership.id,
        roleId: role.id,
      })),
    });
  }

  async function setMembershipRolesByEmail(
    email: string,
    projectSlug: string,
    roleCodes: string[],
  ) {
    const user = await app.prisma.user.findUniqueOrThrow({
      where: {
        emailNormalized: email.toLowerCase(),
      },
    });

    await setMembershipRoles(user.id, projectSlug, roleCodes);
  }

  async function getProjectId(projectSlug: string) {
    const project = await app.prisma.project.findUniqueOrThrow({
      where: {
        slug: projectSlug,
      },
    });

    return project.id;
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

  async function findCurrentProjectSessionId(projectSlug: string, cookie: string) {
    const sessionToken = extractCookieValue(cookie);
    const session = await app.prisma.session.findUniqueOrThrow({
      where: {
        secretHash: hashSessionToken(sessionToken),
      },
      select: {
        id: true,
        project: {
          select: {
            slug: true,
          },
        },
      },
    });

    if (session.project?.slug !== projectSlug) {
      throw new Error('Expected a session for the requested project');
    }

    return session.id;
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

function extractCookieValue(setCookieHeader: string): string {
  const cookiePair = extractCookiePair(setCookieHeader);
  const [, value] = cookiePair.split('=', 2);

  return value ?? '';
}
