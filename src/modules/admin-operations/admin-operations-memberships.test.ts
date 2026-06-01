import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';
import { bootstrapServicePrincipal } from '../identity/bootstrap/service-principal-bootstrap.js';
import { upsertProjectSeedData } from '../identity/bootstrap/project-seed.js';

describe('admin operations membership and session mutations', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let otherGptId: string;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
  });

  beforeEach(async () => {
    await clearData();
    await upsertProjectSeedData(app.prisma);
    otherGptId = await getProjectId('other-gpt');
    const principal = await bootstrapServicePrincipal(app.prisma, {
      slug: 'mcp-server',
      name: 'MCP Server',
      projectSlugs: ['other-gpt'],
    });
    token = principal.token;
  });

  afterAll(async () => {
    await clearData();
    await app.close();
  });

  it('assigns non-admin roles directly (low risk)', async () => {
    const userId = await seedUserMembership('roles@example.com', ['user']);

    const response = await post('/admin/memberships/roles', {
      idempotencyKey: 'roles-1',
      payload: { userId, roleCodes: ['pro'] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('completed');
    expect(await membershipRoleCodes(userId)).toEqual(['pro']);
  });

  it('gates assigning the admin role behind a confirmation', async () => {
    const userId = await seedUserMembership('toadmin@example.com', ['user']);

    const requested = await post('/admin/memberships/roles', {
      idempotencyKey: 'roles-admin',
      operatorUserId: 'requester-1',
      payload: { userId, roleCodes: ['admin'] },
    });
    expect(requested.json().status).toBe('pending_approval');
    expect(await membershipRoleCodes(userId)).toEqual(['user']);

    const decision = await decide(requested.json().approvalId, 'approve', 'requester-1');
    expect(decision.json().status).toBe('completed');
    expect(await membershipRoleCodes(userId)).toEqual(['admin']);
  });

  it('revokes project access directly and protects the last active admin', async () => {
    const memberId = await seedUserMembership('member@example.com', ['user']);

    const ok = await post('/admin/memberships/revoke', {
      idempotencyKey: 'revoke-1',
      payload: { userId: memberId },
    });
    expect(ok.json().status).toBe('completed');
    expect(await membershipStatus(memberId)).toBe('REVOKED');

    const soleAdminId = await seedUserMembership('admin@example.com', ['admin']);
    const blocked = await post('/admin/memberships/revoke', {
      idempotencyKey: 'revoke-admin',
      payload: { userId: soleAdminId },
    });
    expect(blocked.json().status).toBe('failed');
    expect(blocked.json().message).toContain('active project admin');
    expect(await membershipStatus(soleAdminId)).toBe('ACTIVE');
  });

  it('readmits a revoked membership after confirmation (high risk)', async () => {
    const userId = await seedUserMembership('readmit@example.com', ['user']);
    await post('/admin/memberships/revoke', {
      idempotencyKey: 'readmit-revoke',
      payload: { userId },
    });
    expect(await membershipStatus(userId)).toBe('REVOKED');

    const requested = await post('/admin/memberships/readmit', {
      idempotencyKey: 'readmit-1',
      operatorUserId: 'requester-1',
      payload: { userId },
    });
    expect(requested.json().status).toBe('pending_approval');
    expect(await membershipStatus(userId)).toBe('REVOKED');

    const decision = await decide(requested.json().approvalId, 'approve', 'requester-1');
    expect(decision.json().status).toBe('completed');
    expect(await membershipStatus(userId)).toBe('ACTIVE');
    expect(await membershipRoleCodes(userId)).toEqual(['user']);
  });

  it('revokes a single session directly', async () => {
    const userId = await seedUserMembership('single@example.com', ['user']);
    const sessionId = await createSession(userId);

    const response = await post('/admin/sessions/revoke', {
      idempotencyKey: 'session-single',
      payload: { sessionId },
    });

    expect(response.json().status).toBe('completed');
    expect(response.json().result.revokedCount).toBe(1);
    expect(await sessionStatus(sessionId)).toBe('REVOKED');
  });

  it('gates a mass session revoke behind a confirmation', async () => {
    const userId = await seedUserMembership('mass@example.com', ['user']);
    const first = await createSession(userId);
    const second = await createSession(userId);

    const requested = await post('/admin/sessions/revoke', {
      idempotencyKey: 'session-mass',
      operatorUserId: 'requester-1',
      payload: { userId },
    });
    expect(requested.json().status).toBe('pending_approval');
    expect(await sessionStatus(first)).toBe('ACTIVE');

    const decision = await decide(requested.json().approvalId, 'approve', 'requester-1');
    expect(decision.json().status).toBe('completed');
    expect(decision.json().result.revokedCount).toBe(2);
    expect(await sessionStatus(first)).toBe('REVOKED');
    expect(await sessionStatus(second)).toBe('REVOKED');
  });

  it('rejects a revoke-session body without exactly one target', async () => {
    const response = await post('/admin/sessions/revoke', {
      idempotencyKey: 'session-bad',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  async function post(url: string, body: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        targetProjectId: otherGptId,
        reason: 'test',
        channel: 'postman',
        ...body,
      },
    });
  }

  async function decide(
    approvalId: string,
    decision: 'approve' | 'reject',
    operatorUserId: string,
  ) {
    return app.inject({
      method: 'POST',
      url: `/admin/approvals/${approvalId}/decide`,
      headers: { authorization: `Bearer ${token}` },
      payload: { decision, operatorUserId },
    });
  }

  async function seedUserMembership(email: string, roleCodes: string[]): Promise<string> {
    const user = await app.prisma.user.create({
      data: { email, emailNormalized: email.toLowerCase() },
      select: { id: true },
    });
    const roles = await app.prisma.projectRole.findMany({
      where: { projectId: otherGptId, code: { in: roleCodes } },
      select: { id: true },
    });
    await app.prisma.projectMembership.create({
      data: {
        projectId: otherGptId,
        userId: user.id,
        status: 'ACTIVE',
        membershipRoles: { create: roles.map((role) => ({ roleId: role.id })) },
      },
    });
    return user.id;
  }

  async function createSession(userId: string): Promise<string> {
    const session = await app.prisma.session.create({
      data: {
        userId,
        projectId: otherGptId,
        secretHash: randomUUID(),
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + 3_600_000),
      },
      select: { id: true },
    });
    return session.id;
  }

  async function membershipRoleCodes(userId: string): Promise<string[]> {
    const membership = await app.prisma.projectMembership.findUniqueOrThrow({
      where: { projectId_userId: { projectId: otherGptId, userId } },
      select: { membershipRoles: { select: { role: { select: { code: true } } } } },
    });
    return membership.membershipRoles.map((membershipRole) => membershipRole.role.code).sort();
  }

  async function membershipStatus(userId: string): Promise<string> {
    const membership = await app.prisma.projectMembership.findUniqueOrThrow({
      where: { projectId_userId: { projectId: otherGptId, userId } },
      select: { status: true },
    });
    return membership.status;
  }

  async function sessionStatus(sessionId: string): Promise<string> {
    const session = await app.prisma.session.findUniqueOrThrow({
      where: { id: sessionId },
      select: { status: true },
    });
    return session.status;
  }

  async function getProjectId(slug: string): Promise<string> {
    const project = await app.prisma.project.findUniqueOrThrow({
      where: { slug },
      select: { id: true },
    });
    return project.id;
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
