import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';
import { upsertProjectSeedData } from '../identity/bootstrap/project-seed.js';
import { pruneAdminOperations } from './admin-operations.retention.js';

describe('pruneAdminOperations', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let otherGptId: string;

  beforeAll(async () => {
    app = await buildApp();
  });

  beforeEach(async () => {
    await clearData();
    await upsertProjectSeedData(app.prisma);
    otherGptId = await getProjectId('other-gpt');
  });

  afterAll(async () => {
    await clearData();
    await app.close();
  });

  it('rejects a non-positive retention window', async () => {
    await expect(
      pruneAdminOperations(app.prisma, { retentionDays: 0, dryRun: true }),
    ).rejects.toThrow(expect.objectContaining({ code: 'ADMIN_RETENTION_DAYS_INVALID' }));
  });

  it('counts candidates without deleting on a dry run', async () => {
    await createOperation({ status: 'COMPLETED', ageDays: 120 });
    await createOperation({ status: 'FAILED', ageDays: 120 });

    const result = await pruneAdminOperations(app.prisma, { retentionDays: 90, dryRun: true });

    expect(result.candidateCount).toBe(2);
    expect(result.deletedCount).toBe(0);
    expect(await app.prisma.adminOperation.count()).toBe(2);
  });

  it('prunes only terminal operations older than the window', async () => {
    const oldCompleted = await createOperation({ status: 'COMPLETED', ageDays: 120 });
    const oldDenied = await createOperation({ status: 'DENIED', ageDays: 200 });
    const oldPending = await createOperation({ status: 'PENDING_APPROVAL', ageDays: 300 });
    const recentCompleted = await createOperation({ status: 'COMPLETED', ageDays: 10 });

    const result = await pruneAdminOperations(app.prisma, { retentionDays: 90, dryRun: false });

    expect(result.deletedCount).toBe(2);

    const survivingIds = (await app.prisma.adminOperation.findMany({ select: { id: true } })).map(
      (operation) => operation.id,
    );
    expect(survivingIds.sort()).toEqual([oldPending, recentCompleted].sort());
    expect(survivingIds).not.toContain(oldCompleted);
    expect(survivingIds).not.toContain(oldDenied);
  });

  it('cascades to audit and approval rows when pruning', async () => {
    await createOperation({ status: 'COMPLETED', ageDays: 120, withAuditAndApproval: true });

    const result = await pruneAdminOperations(app.prisma, { retentionDays: 90, dryRun: false });

    expect(result.deletedCount).toBe(1);
    expect(await app.prisma.adminActionAudit.count()).toBe(0);
    expect(await app.prisma.adminApproval.count()).toBe(0);
  });

  it('exports the matching operations with their audit history', async () => {
    await createOperation({ status: 'COMPLETED', ageDays: 120, withAuditAndApproval: true });

    const result = await pruneAdminOperations(app.prisma, {
      retentionDays: 90,
      dryRun: true,
      includeExport: true,
    });

    expect(result.exported).not.toBeNull();
    const exportedList = result.exported as Array<{
      operationName: string;
      auditEvents: unknown[];
      approval: unknown;
    }>;
    expect(exportedList).toHaveLength(1);
    const exported = exportedList[0];
    expect(exported?.operationName).toBe('auth.banUser');
    expect((exported?.auditEvents ?? []).length).toBeGreaterThan(0);
    expect(exported?.approval).not.toBeNull();
    // Dry run: export does not delete.
    expect(await app.prisma.adminOperation.count()).toBe(1);
  });

  async function createOperation(input: {
    status: 'COMPLETED' | 'PENDING_APPROVAL' | 'DENIED' | 'FAILED';
    ageDays: number;
    withAuditAndApproval?: boolean;
  }): Promise<string> {
    const createdAt = new Date(Date.now() - input.ageDays * 24 * 60 * 60 * 1000);
    const operation = await app.prisma.adminOperation.create({
      data: {
        operationName: 'auth.banUser',
        status: input.status,
        idempotencyKey: randomUUID(),
        sourceChannel: 'test',
        reason: 'retention test',
        targetProjectId: otherGptId,
        createdAt,
      },
      select: { id: true },
    });

    if (input.withAuditAndApproval === true) {
      await app.prisma.adminActionAudit.create({
        data: { operationId: operation.id, eventType: 'REQUESTED' },
      });
      await app.prisma.adminActionAudit.create({
        data: { operationId: operation.id, eventType: 'COMPLETED' },
      });
      await app.prisma.adminApproval.create({
        data: {
          operationId: operation.id,
          status: 'APPROVED',
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
