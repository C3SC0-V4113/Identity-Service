import argon2 from 'argon2';
import { UserStatus } from '../../shared/db/prisma-types.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';
import { upsertProjectSeedData } from '../identity/bootstrap/project-seed.js';
import { authResponseSchema } from './auth.schemas.js';
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

  it('registers a user, stores a hashed credential and persists a session cookie', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: '  Person@Example.com ',
        password: 'supersecret',
        displayName: '  Person  ',
      },
    });

    expect(response.statusCode).toBe(201);
    const parsedResponse = authResponseSchema.parse(response.json());
    expect(parsedResponse.user.id).toEqual(expect.any(String));
    expect(parsedResponse.user.email).toBe('Person@Example.com');
    expect(parsedResponse.user.displayName).toBe('Person');
    expect(parsedResponse.user.status).toBe('ACTIVE');
    expect(parsedResponse.user.createdAt).toEqual(expect.any(String));
    expect(parsedResponse.user.memberships).toEqual([]);

    const sessionCookie = getRequiredSessionCookie(response);
    const sessionToken = extractCookieValue(sessionCookie);
    const createdUser = await app.prisma.user.findUniqueOrThrow({
      where: {
        emailNormalized: 'person@example.com',
      },
      include: {
        localCredential: true,
        sessions: true,
      },
    });

    expect(createdUser.localCredential).not.toBeNull();
    expect(createdUser.sessions).toHaveLength(1);
    expect(createdUser.sessions[0]?.secretHash).toHaveLength(64);
    expect(createdUser.sessions[0]?.secretHash).not.toBe(sessionToken);
    expect(sessionCookie).toContain(`${getSessionCookieName()}=`);
    expect(sessionCookie).toContain('HttpOnly');
  });

  it('rejects duplicate registrations by normalized email', async () => {
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'person@example.com',
        password: 'supersecret',
      },
    });

    const duplicateResponse = await app.inject({
      method: 'POST',
      url: '/auth/register',
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

  it('logs in with valid credentials and creates a new session', async () => {
    await createUser({
      email: 'person@example.com',
      password: 'supersecret',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: 'PERSON@example.com',
        password: 'supersecret',
      },
    });

    expect(response.statusCode).toBe(200);
    const parsedResponse = authResponseSchema.parse(response.json());
    expect(parsedResponse.user.email).toBe('person@example.com');
    expect(parsedResponse.user.memberships).toEqual([]);
    expect(getRequiredSessionCookie(response)).toContain(`${getSessionCookieName()}=`);

    const persistedSessions = await app.prisma.session.findMany();
    expect(persistedSessions).toHaveLength(1);
  });

  it('rejects login with an invalid password', async () => {
    await createUser({
      email: 'person@example.com',
      password: 'supersecret',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
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
        status: UserStatus.BANNED,
        bannedAt: new Date(),
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
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

  it('revokes only the current session on logout and clears the cookie', async () => {
    const registerResponse = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'person@example.com',
        password: 'supersecret',
      },
    });

    const sessionCookie = getRequiredSessionCookie(registerResponse);

    const response = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: {
        cookie: extractCookiePair(sessionCookie),
      },
    });

    expect(response.statusCode).toBe(204);

    const persistedSession = await app.prisma.session.findFirstOrThrow();
    expect(persistedSession.status).toBe('REVOKED');
    expect(persistedSession.revokedReason).toBe('USER_LOGOUT');

    const clearedCookie = response.headers['set-cookie'];
    expect(clearedCookie).toBeDefined();
    expect(Array.isArray(clearedCookie) ? clearedCookie[0] : clearedCookie).toContain('Max-Age=0');
  });

  it('returns the authenticated profile with memberships and roles and updates lastSeenAt', async () => {
    const registerResponse = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'person@example.com',
        password: 'supersecret',
        displayName: 'Person',
      },
    });

    const responseBody = authResponseSchema.parse(registerResponse.json());
    const userId = responseBody.user.id;

    const project = await app.prisma.project.findUniqueOrThrow({
      where: {
        slug: 'other-gpt',
      },
      include: {
        roles: {
          where: {
            code: {
              in: ['user', 'pro'],
            },
          },
        },
      },
    });

    await app.prisma.projectMembership.create({
      data: {
        userId,
        projectId: project.id,
        membershipRoles: {
          create: project.roles.map((role: (typeof project.roles)[number]) => ({
            roleId: role.id,
          })),
        },
      },
    });

    const sessionBeforeMe = await app.prisma.session.findFirstOrThrow({
      where: {
        userId,
      },
    });

    expect(sessionBeforeMe.lastSeenAt).toBeNull();

    const meResponse = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: {
        cookie: extractCookiePair(getRequiredSessionCookie(registerResponse)),
      },
    });

    expect(meResponse.statusCode).toBe(200);
    const parsedMeResponse = authResponseSchema.parse(meResponse.json());
    expect(parsedMeResponse.user.id).toBe(userId);
    expect(parsedMeResponse.user.email).toBe('person@example.com');
    expect(parsedMeResponse.user.displayName).toBe('Person');
    expect(parsedMeResponse.user.status).toBe('ACTIVE');
    expect(parsedMeResponse.user.createdAt).toEqual(expect.any(String));
    expect(parsedMeResponse.user.memberships).toHaveLength(1);
    expect(parsedMeResponse.user.memberships[0]?.id).toEqual(expect.any(String));
    expect(parsedMeResponse.user.memberships[0]?.status).toBe('ACTIVE');
    expect(parsedMeResponse.user.memberships[0]?.project).toEqual({
      id: project.id,
      slug: 'other-gpt',
      name: 'Other GPT',
    });
    expect(parsedMeResponse.user.memberships[0]?.roles).toHaveLength(2);
    expect(parsedMeResponse.user.memberships[0]?.roles[0]?.id).toEqual(expect.any(String));
    expect(parsedMeResponse.user.memberships[0]?.roles[0]?.code).toBe('pro');
    expect(parsedMeResponse.user.memberships[0]?.roles[0]?.name).toBe('Pro');
    expect(parsedMeResponse.user.memberships[0]?.roles[1]?.id).toEqual(expect.any(String));
    expect(parsedMeResponse.user.memberships[0]?.roles[1]?.code).toBe('user');
    expect(parsedMeResponse.user.memberships[0]?.roles[1]?.name).toBe('User');

    const sessionAfterMe = await app.prisma.session.findFirstOrThrow({
      where: {
        userId,
      },
    });

    expect(sessionAfterMe.lastSeenAt).not.toBeNull();
  });

  it('rejects me when no session cookie is present', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication required',
      },
    });
  });

  it('rejects me when the session has been revoked', async () => {
    const registerResponse = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'person@example.com',
        password: 'supersecret',
      },
    });

    const userId = authResponseSchema.parse(registerResponse.json()).user.id;

    await app.prisma.session.updateMany({
      where: {
        userId,
      },
      data: {
        status: 'REVOKED',
        revokedAt: new Date(),
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: {
        cookie: extractCookiePair(getRequiredSessionCookie(registerResponse)),
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

  it('rejects me when the session has expired', async () => {
    const registerResponse = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'person@example.com',
        password: 'supersecret',
      },
    });

    const userId = authResponseSchema.parse(registerResponse.json()).user.id;

    await app.prisma.session.updateMany({
      where: {
        userId,
      },
      data: {
        expiresAt: new Date(Date.now() - 1_000),
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: {
        cookie: extractCookiePair(getRequiredSessionCookie(registerResponse)),
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication required',
      },
    });

    const persistedSession = await app.prisma.session.findFirstOrThrow({
      where: {
        userId,
      },
    });
    expect(persistedSession.status).toBe('EXPIRED');
  });

  async function clearAuthData() {
    await app.prisma.projectMembershipRole.deleteMany();
    await app.prisma.projectMembership.deleteMany();
    await app.prisma.session.deleteMany();
    await app.prisma.localCredential.deleteMany();
    await app.prisma.user.deleteMany();
  }

  async function createUser(input: { email: string; password: string }) {
    const passwordHash = await argon2.hash(input.password);

    return app.prisma.user.create({
      data: {
        email: input.email,
        emailNormalized: input.email.toLowerCase(),
        localCredential: {
          create: {
            passwordHash,
          },
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

function extractCookieValue(setCookieHeader: string): string {
  const cookiePair = extractCookiePair(setCookieHeader);
  const [, value] = cookiePair.split('=', 2);

  return value ?? '';
}
