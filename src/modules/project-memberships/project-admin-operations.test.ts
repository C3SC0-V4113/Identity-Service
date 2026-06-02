import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';
import { hashSessionToken } from '../../shared/auth/session-auth.js';
import { getSessionCookieName } from '../auth/auth.cookies.js';
import { upsertProjectSeedData } from '../identity/bootstrap/project-seed.js';

describe('GET /projects/:slug/admin-operations', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let otherGptId: string;
  let costConsoleId: string;

  beforeAll(async () => {
    app = await buildApp();
  });

  beforeEach(async () => {
    await clearData();
    await upsertProjectSeedData(app.prisma);
    otherGptId = await getProjectId('other-gpt');
    costConsoleId = await getProjectId('cost-console');
  });

  afterAll(async () => {
    await clearData();
    await app.close();
  });

  it('lets a project admin read machine operations scoped to the project', async () => {
    const admin = await createMember(['admin']);
    await createOperation(otherGptId, { operationName: 'auth.createUser', status: 'COMPLETED' });
    await createOperation(otherGptId, {
      operationName: 'auth.banUser',
      status: 'PENDING_APPROVAL',
      withApproval: true,
    });
    // An operation in another project must not leak.
    await createOperation(costConsoleId, { operationName: 'auth.createUser', status: 'COMPLETED' });

    const response = await app.inject({
      method: 'GET',
      url: '/projects/other-gpt/admin-operations',
      headers: { cookie: admin.cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.project.slug).toBe('other-gpt');
    expect(body.items).toHaveLength(2);
    expect(body.items.map((item: { operationName: string }) => item.operationName).sort()).toEqual([
      'auth.banUser',
      'auth.createUser',
    ]);

    const pending = body.items.find(
      (item: { operationName: string }) => item.operationName === 'auth.banUser',
    );
    expect(pending.status).toBe('PENDING_APPROVAL');
    expect(pending.approval).not.toBeNull();
    expect(pending.approval.status).toBe('PENDING');
  });

  it('filters by status and operationName', async () => {
    const admin = await createMember(['admin']);
    await createOperation(otherGptId, { operationName: 'auth.createUser', status: 'COMPLETED' });
    await createOperation(otherGptId, { operationName: 'auth.banUser', status: 'FAILED' });

    const byStatus = await app.inject({
      method: 'GET',
      url: '/projects/other-gpt/admin-operations?status=FAILED',
      headers: { cookie: admin.cookie },
    });
    expect(byStatus.json().items).toHaveLength(1);
    expect(byStatus.json().items[0].operationName).toBe('auth.banUser');

    const byName = await app.inject({
      method: 'GET',
      url: '/projects/other-gpt/admin-operations?operationName=auth.createUser',
      headers: { cookie: admin.cookie },
    });
    expect(byName.json().items).toHaveLength(1);
    expect(byName.json().items[0].status).toBe('COMPLETED');
  });

  it('rejects a non-admin project member', async () => {
    const member = await createMember(['user']);
    await createOperation(otherGptId, { operationName: 'auth.createUser', status: 'COMPLETED' });

    const response = await app.inject({
      method: 'GET',
      url: '/projects/other-gpt/admin-operations',
      headers: { cookie: member.cookie },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('PROJECT_ADMIN_REQUIRED');
  });

  it('requires authentication', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/projects/other-gpt/admin-operations',
    });

    expect(response.statusCode).toBe(401);
  });

  async function createMember(roleCodes: string[]): Promise<{ userId: string; cookie: string }> {
    const email = `${randomUUID()}@example.com`;
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

    const token = randomBytes(32).toString('base64url');
    await app.prisma.session.create({
      data: {
        userId: user.id,
        projectId: otherGptId,
        secretHash: hashSessionToken(token),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    return { userId: user.id, cookie: `${getSessionCookieName()}=${token}` };
  }

  async function createOperation(
    projectId: string,
    input: {
      operationName: string;
      status: 'COMPLETED' | 'PENDING_APPROVAL' | 'DENIED' | 'FAILED';
      withApproval?: boolean;
    },
  ) {
    const operation = await app.prisma.adminOperation.create({
      data: {
        operationName: input.operationName,
        status: input.status,
        idempotencyKey: randomUUID(),
        sourceChannel: 'test',
        reason: 'test op',
        targetProjectId: projectId,
      },
      select: { id: true },
    });

    if (input.withApproval === true) {
      await app.prisma.adminApproval.create({
        data: {
          operationId: operation.id,
          status: 'PENDING',
          requiredApprovalLevel: 'confirmation',
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
    }

    return operation.id;
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
