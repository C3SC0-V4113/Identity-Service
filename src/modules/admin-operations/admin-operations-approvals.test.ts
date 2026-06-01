import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';
import { bootstrapServicePrincipal } from '../identity/bootstrap/service-principal-bootstrap.js';
import { upsertProjectSeedData } from '../identity/bootstrap/project-seed.js';

describe('admin operations approval lifecycle', () => {
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

  it('requests a ban as pending_approval without applying the ban', async () => {
    const userId = await createUser('ban-me@example.com');

    const response = await requestBan(userId, 'ban-1', 'requester-1');

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('pending_approval');
    expect(body.approvalId).toEqual(expect.any(String));

    const user = await app.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { status: true },
    });
    expect(user.status).toBe('ACTIVE');

    const operation = await app.prisma.adminOperation.findFirstOrThrow({
      where: { idempotencyKey: 'ban-1' },
      select: { status: true },
    });
    expect(operation.status).toBe('PENDING_APPROVAL');

    const approval = await app.prisma.adminApproval.findUniqueOrThrow({
      where: { id: body.approvalId },
      select: { status: true, requestedByUserId: true },
    });
    expect(approval.status).toBe('PENDING');
    expect(approval.requestedByUserId).toBe('requester-1');

    const events = await app.prisma.adminActionAudit.findMany({
      where: { operationId: body.operationId },
      select: { eventType: true },
      orderBy: { occurredAt: 'asc' },
    });
    expect(events.map((event) => event.eventType)).toEqual(['REQUESTED', 'PENDING_APPROVAL']);

    const approvals = await app.inject({
      method: 'GET',
      url: `/admin/approvals?targetProjectId=${otherGptId}`,
      headers: authHeader(scopedToken),
    });
    expect(approvals.json().items).toHaveLength(1);
  });

  it('allows an approval-gated request without an operatorUserId', async () => {
    const userId = await createUser('no-operator@example.com');

    const response = await app.inject({
      method: 'POST',
      url: '/admin/users/ban',
      headers: authHeader(scopedToken),
      payload: {
        targetProjectId: otherGptId,
        reason: 'ban without operator',
        idempotencyKey: 'ban-no-op',
        channel: 'telegram',
        payload: { userId },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('pending_approval');
  });

  it('allows the same operator to confirm the operation (two-step guard, not two-person)', async () => {
    const userId = await createUser('self-approve@example.com');
    const requested = await requestBan(userId, 'ban-self', 'requester-1');

    const decision = await decide(requested.json().approvalId, 'approve', 'requester-1');

    expect(decision.statusCode).toBe(200);
    expect(decision.json().status).toBe('completed');

    const user = await app.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { status: true },
    });
    expect(user.status).toBe('BANNED');
  });

  it('applies the ban when a second operator approves', async () => {
    const userId = await createUser('approve-me@example.com');
    const requested = await requestBan(userId, 'ban-approve', 'requester-1');
    const approvalId = requested.json().approvalId;

    const decision = await decide(approvalId, 'approve', 'approver-2');

    expect(decision.statusCode).toBe(200);
    expect(decision.json().status).toBe('completed');
    expect(decision.json().result.user.status).toBe('BANNED');

    const user = await app.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { status: true, bannedAt: true },
    });
    expect(user.status).toBe('BANNED');
    expect(user.bannedAt).not.toBeNull();

    const operation = await app.prisma.adminOperation.findFirstOrThrow({
      where: { idempotencyKey: 'ban-approve' },
      select: { status: true },
    });
    expect(operation.status).toBe('COMPLETED');

    const approval = await app.prisma.adminApproval.findUniqueOrThrow({
      where: { id: approvalId },
      select: { status: true, approvedByUserId: true },
    });
    expect(approval.status).toBe('APPROVED');
    expect(approval.approvedByUserId).toBe('approver-2');

    const events = await app.prisma.adminActionAudit.findMany({
      where: { operationId: requested.json().operationId },
      select: { eventType: true },
      orderBy: { occurredAt: 'asc' },
    });
    expect(events.map((event) => event.eventType)).toEqual([
      'REQUESTED',
      'PENDING_APPROVAL',
      'APPROVED',
      'COMPLETED',
    ]);
  });

  it('is idempotent when approving an already-approved operation', async () => {
    const userId = await createUser('twice@example.com');
    const requested = await requestBan(userId, 'ban-twice', 'requester-1');
    const approvalId = requested.json().approvalId;

    const first = await decide(approvalId, 'approve', 'approver-2');
    const second = await decide(approvalId, 'approve', 'approver-2');

    expect(first.json().status).toBe('completed');
    expect(second.json().status).toBe('completed');

    const completedEvents = await app.prisma.adminActionAudit.count({
      where: { operationId: requested.json().operationId, eventType: 'COMPLETED' },
    });
    expect(completedEvents).toBe(1);
  });

  it('rejects the operation when the approver denies it', async () => {
    const userId = await createUser('reject-me@example.com');
    const requested = await requestBan(userId, 'ban-reject', 'requester-1');

    const decision = await decide(
      requested.json().approvalId,
      'reject',
      'approver-2',
      'Not warranted',
    );

    expect(decision.statusCode).toBe(200);
    expect(decision.json().status).toBe('denied');

    const user = await app.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { status: true },
    });
    expect(user.status).toBe('ACTIVE');

    const operation = await app.prisma.adminOperation.findFirstOrThrow({
      where: { idempotencyKey: 'ban-reject' },
      select: { status: true },
    });
    expect(operation.status).toBe('DENIED');
  });

  it('denies a decision once the approval has expired', async () => {
    const userId = await createUser('expired@example.com');
    const requested = await requestBan(userId, 'ban-expired', 'requester-1');
    const approvalId = requested.json().approvalId;

    await app.prisma.adminApproval.update({
      where: { id: approvalId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const decision = await decide(approvalId, 'approve', 'approver-2');

    expect(decision.json().status).toBe('denied');
    expect(decision.json().message).toContain('expired');

    const user = await app.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { status: true },
    });
    expect(user.status).toBe('ACTIVE');

    const approval = await app.prisma.adminApproval.findUniqueOrThrow({
      where: { id: approvalId },
      select: { status: true },
    });
    expect(approval.status).toBe('EXPIRED');
  });

  it('unbans a user directly (low-risk, no approval)', async () => {
    const userId = await createUser('unban-me@example.com');
    await app.prisma.user.update({
      where: { id: userId },
      data: { status: 'BANNED', bannedAt: new Date() },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/admin/users/unban',
      headers: authHeader(scopedToken),
      payload: {
        targetProjectId: otherGptId,
        reason: 'mistaken ban',
        idempotencyKey: 'unban-1',
        channel: 'telegram',
        payload: { userId },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('completed');

    const user = await app.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { status: true, bannedAt: true },
    });
    expect(user.status).toBe('ACTIVE');
    expect(user.bannedAt).toBeNull();
  });

  it('denies a ban targeting a project outside the allow-list', async () => {
    const userId = await createUser('out-of-scope@example.com');

    const response = await app.inject({
      method: 'POST',
      url: '/admin/users/ban',
      headers: authHeader(scopedToken),
      payload: {
        targetProjectId: costConsoleId,
        reason: 'should be denied',
        idempotencyKey: 'ban-scope',
        channel: 'telegram',
        operatorUserId: 'requester-1',
        payload: { userId },
      },
    });

    expect(response.json().status).toBe('denied');

    const approvalCount = await app.prisma.adminApproval.count();
    expect(approvalCount).toBe(0);
  });

  function authHeader(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  async function requestBan(userId: string, idempotencyKey: string, operatorUserId: string) {
    return app.inject({
      method: 'POST',
      url: '/admin/users/ban',
      headers: authHeader(scopedToken),
      payload: {
        targetProjectId: otherGptId,
        reason: 'ban requested',
        idempotencyKey,
        channel: 'telegram',
        operatorUserId,
        payload: { userId },
      },
    });
  }

  async function decide(
    approvalId: string,
    decision: 'approve' | 'reject',
    operatorUserId: string,
    decisionReason?: string,
  ) {
    return app.inject({
      method: 'POST',
      url: `/admin/approvals/${approvalId}/decide`,
      headers: authHeader(scopedToken),
      payload: { decision, operatorUserId, decisionReason },
    });
  }

  async function createUser(email: string): Promise<string> {
    const user = await app.prisma.user.create({
      data: { email, emailNormalized: email.toLowerCase() },
      select: { id: true },
    });
    return user.id;
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
