import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';
import { bootstrapServicePrincipal } from '../identity/bootstrap/service-principal-bootstrap.js';
import { upsertProjectSeedData } from '../identity/bootstrap/project-seed.js';
import { ADMIN_POLICY_VERSION } from './admin-operations.policy.js';

describe('admin operations surface', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let otherGptId: string;
  let costConsoleId: string;
  let scopedToken: string;

  beforeAll(async () => {
    app = await buildApp();
  });

  beforeEach(async () => {
    await clearData();
    await upsertProjectSeedData(app.prisma);

    otherGptId = await getProjectId('other-gpt');
    costConsoleId = await getProjectId('cost-console');

    const scoped = await bootstrapServicePrincipal(app.prisma, {
      slug: 'mcp-server',
      name: 'MCP Server',
      projectSlugs: ['other-gpt'],
    });
    scopedToken = scoped.token;
  });

  afterAll(async () => {
    await clearData();
    await app.close();
  });

  it('requires a service-principal bearer token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/admin/users?targetProjectId=${otherGptId}`,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('SERVICE_PRINCIPAL_AUTH_REQUIRED');
  });

  it('rejects a disabled service principal', async () => {
    await app.prisma.servicePrincipal.update({
      where: { slug: 'mcp-server' },
      data: { status: 'DISABLED' },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/admin/users?targetProjectId=${otherGptId}`,
      headers: authHeader(scopedToken),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('SERVICE_PRINCIPAL_DISABLED');
  });

  it('creates a user and admits it with the default role (completed)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: authHeader(scopedToken),
      payload: {
        targetProjectId: otherGptId,
        reason: 'Onboarding a demo user',
        idempotencyKey: 'create-user-1',
        channel: 'telegram',
        operatorUserId: 'operator-123',
        payload: {
          email: 'New.User@example.com',
          displayName: 'New User',
          password: 'supersecret',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('completed');
    expect(body.operationId).toEqual(expect.any(String));
    expect(body.auditEventId).toEqual(expect.any(String));
    expect(body.result.user.email).toBe('New.User@example.com');
    expect(body.result.membership.roles.map((role: { code: string }) => role.code)).toEqual([
      'user',
    ]);

    const persistedUser = await app.prisma.user.findUnique({
      where: { emailNormalized: 'new.user@example.com' },
      select: { id: true, localCredential: { select: { id: true } } },
    });
    expect(persistedUser).not.toBeNull();
    expect(persistedUser?.localCredential).not.toBeNull();

    const operation = await app.prisma.adminOperation.findUniqueOrThrow({
      where: {
        servicePrincipalId_idempotencyKey: {
          servicePrincipalId: await principalId('mcp-server'),
          idempotencyKey: 'create-user-1',
        },
      },
      select: {
        status: true,
        operationName: true,
        targetProjectId: true,
        policyVersion: true,
      },
    });
    expect(operation.status).toBe('COMPLETED');
    expect(operation.operationName).toBe('auth.createUser');
    expect(operation.targetProjectId).toBe(otherGptId);
    expect(operation.policyVersion).toBe(ADMIN_POLICY_VERSION);

    const auditEvents = await app.prisma.adminActionAudit.findMany({
      where: { operationId: body.operationId },
      select: { eventType: true },
      orderBy: { occurredAt: 'asc' },
    });
    expect(auditEvents.map((event) => event.eventType)).toEqual(['REQUESTED', 'COMPLETED']);
  });

  it('replays the same idempotency key without creating a second user', async () => {
    const payload = {
      targetProjectId: otherGptId,
      reason: 'Onboarding a demo user',
      idempotencyKey: 'create-user-idem',
      channel: 'telegram',
      payload: { email: 'idem@example.com', password: 'supersecret' },
    };

    const first = await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: authHeader(scopedToken),
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: authHeader(scopedToken),
      payload,
    });

    expect(first.json().status).toBe('completed');
    expect(second.json().status).toBe('completed');
    expect(second.json().operationId).toBe(first.json().operationId);

    const userCount = await app.prisma.user.count({
      where: { emailNormalized: 'idem@example.com' },
    });
    expect(userCount).toBe(1);

    const operationCount = await app.prisma.adminOperation.count({
      where: { idempotencyKey: 'create-user-idem' },
    });
    expect(operationCount).toBe(1);
  });

  it('denies a target project outside the principal allow-list', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: authHeader(scopedToken),
      payload: {
        targetProjectId: costConsoleId,
        reason: 'Should be denied',
        idempotencyKey: 'denied-1',
        channel: 'telegram',
        payload: { email: 'denied@example.com', password: 'supersecret' },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('denied');
    expect(body.result).toBeNull();

    const userCount = await app.prisma.user.count({
      where: { emailNormalized: 'denied@example.com' },
    });
    expect(userCount).toBe(0);

    const operation = await app.prisma.adminOperation.findFirstOrThrow({
      where: { idempotencyKey: 'denied-1' },
      select: { status: true, errorCode: true },
    });
    expect(operation.status).toBe('DENIED');
    expect(operation.errorCode).toBe('SERVICE_PRINCIPAL_PROJECT_FORBIDDEN');
  });

  it('returns a failed envelope when the user already exists', async () => {
    await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: authHeader(scopedToken),
      payload: {
        targetProjectId: otherGptId,
        reason: 'first create',
        idempotencyKey: 'dup-1',
        channel: 'telegram',
        payload: { email: 'dup@example.com', password: 'supersecret' },
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: authHeader(scopedToken),
      payload: {
        targetProjectId: otherGptId,
        reason: 'second create',
        idempotencyKey: 'dup-2',
        channel: 'telegram',
        payload: { email: 'dup@example.com', password: 'supersecret' },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('failed');
    expect(body.message).toContain('already exists');

    const operation = await app.prisma.adminOperation.findFirstOrThrow({
      where: { idempotencyKey: 'dup-2' },
      select: { status: true, errorCode: true },
    });
    expect(operation.status).toBe('FAILED');
    expect(operation.errorCode).toBe('USER_ALREADY_EXISTS');
  });

  it('lists project users and reports access status', async () => {
    await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: authHeader(scopedToken),
      payload: {
        targetProjectId: otherGptId,
        reason: 'seed',
        idempotencyKey: 'list-seed',
        channel: 'telegram',
        payload: { email: 'listed@example.com', password: 'supersecret' },
      },
    });

    const listResponse = await app.inject({
      method: 'GET',
      url: `/admin/users?targetProjectId=${otherGptId}`,
      headers: authHeader(scopedToken),
    });
    expect(listResponse.statusCode).toBe(200);
    const listed = listResponse.json();
    expect(listed.items).toHaveLength(1);
    const userId = listed.items[0].user.id;

    const accessResponse = await app.inject({
      method: 'GET',
      url: `/admin/users/${userId}/access?targetProjectId=${otherGptId}`,
      headers: authHeader(scopedToken),
    });
    expect(accessResponse.statusCode).toBe(200);
    const access = accessResponse.json();
    expect(access.access.isMember).toBe(true);
    expect(access.access.status).toBe('ACTIVE');
    expect(access.access.roles.map((role: { code: string }) => role.code)).toEqual(['user']);
  });

  it('forbids reads against a project outside the allow-list', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/admin/users?targetProjectId=${costConsoleId}`,
      headers: authHeader(scopedToken),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('SERVICE_PRINCIPAL_PROJECT_FORBIDDEN');
  });

  it('rejects reusing an idempotency key across different operations', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: authHeader(scopedToken),
      payload: {
        targetProjectId: otherGptId,
        reason: 'create',
        idempotencyKey: 'shared-key',
        channel: 'telegram',
        payload: { email: 'shared@example.com', password: 'supersecret' },
      },
    });
    expect(create.json().status).toBe('completed');
    const createdUserId = create.json().result.user.id;

    const reused = await app.inject({
      method: 'POST',
      url: '/admin/users/unban',
      headers: authHeader(scopedToken),
      payload: {
        targetProjectId: otherGptId,
        reason: 'unban with the same key',
        idempotencyKey: 'shared-key',
        channel: 'telegram',
        payload: { userId: createdUserId },
      },
    });

    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe('ADMIN_IDEMPOTENCY_KEY_REUSED');
  });

  it('re-executes a failed operation when retried with the same idempotency key', async () => {
    const failed = await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: authHeader(scopedToken),
      payload: {
        targetProjectId: otherGptId,
        reason: 'first attempt with a bad role',
        idempotencyKey: 'retry-key',
        channel: 'telegram',
        payload: {
          email: 'retry@example.com',
          password: 'supersecret',
          roleCodes: ['does-not-exist'],
        },
      },
    });
    expect(failed.json().status).toBe('failed');

    const retried = await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: authHeader(scopedToken),
      payload: {
        targetProjectId: otherGptId,
        reason: 'retry with a valid role',
        idempotencyKey: 'retry-key',
        channel: 'telegram',
        payload: { email: 'retry@example.com', password: 'supersecret' },
      },
    });

    expect(retried.statusCode).toBe(200);
    expect(retried.json().status).toBe('completed');

    const operationCount = await app.prisma.adminOperation.count({
      where: { idempotencyKey: 'retry-key' },
    });
    expect(operationCount).toBe(1);

    const events = await app.prisma.adminActionAudit.findMany({
      where: { operationId: retried.json().operationId },
      select: { eventType: true },
      orderBy: { occurredAt: 'asc' },
    });
    expect(events.map((event) => event.eventType)).toEqual([
      'REQUESTED',
      'FAILED',
      'REQUESTED',
      'COMPLETED',
    ]);

    const userCount = await app.prisma.user.count({
      where: { emailNormalized: 'retry@example.com' },
    });
    expect(userCount).toBe(1);
  });

  it('lists pending approvals (empty in this slice)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/admin/approvals?targetProjectId=${otherGptId}`,
      headers: authHeader(scopedToken),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([]);
  });

  function authHeader(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  async function getProjectId(slug: string): Promise<string> {
    const project = await app.prisma.project.findUniqueOrThrow({
      where: { slug },
      select: { id: true },
    });
    return project.id;
  }

  async function principalId(slug: string): Promise<string> {
    const principal = await app.prisma.servicePrincipal.findUniqueOrThrow({
      where: { slug },
      select: { id: true },
    });
    return principal.id;
  }

  async function clearData() {
    await app.prisma.adminActionAudit.deleteMany();
    await app.prisma.adminApproval.deleteMany();
    await app.prisma.adminOperation.deleteMany();
    await app.prisma.servicePrincipalProjectScope.deleteMany();
    await app.prisma.servicePrincipal.deleteMany();
    await app.prisma.projectMembershipRole.deleteMany();
    await app.prisma.projectMembershipAuditLog.deleteMany();
    await app.prisma.projectMembership.deleteMany();
    await app.prisma.session.deleteMany();
    await app.prisma.localCredential.deleteMany();
    await app.prisma.user.deleteMany();
  }
});
