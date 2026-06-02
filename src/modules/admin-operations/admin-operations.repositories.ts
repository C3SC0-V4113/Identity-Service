import type { Prisma, PrismaClient } from '../../shared/db/prisma-types.js';

type AdminOperationsDbClient = {
  adminOperation: PrismaClient['adminOperation'];
  adminActionAudit: PrismaClient['adminActionAudit'];
  adminApproval: PrismaClient['adminApproval'];
};

export type AdminOperationStatusValue = 'COMPLETED' | 'PENDING_APPROVAL' | 'DENIED' | 'FAILED';

const terminalEventTypeByStatus: Record<
  AdminOperationStatusValue,
  'COMPLETED' | 'PENDING_APPROVAL' | 'DENIED' | 'FAILED'
> = {
  COMPLETED: 'COMPLETED',
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  DENIED: 'DENIED',
  FAILED: 'FAILED',
};

const terminalEventTypes = ['COMPLETED', 'PENDING_APPROVAL', 'DENIED', 'FAILED'] as const;

export async function findOperationByIdempotency(
  prisma: AdminOperationsDbClient,
  servicePrincipalId: string,
  idempotencyKey: string,
) {
  return prisma.adminOperation.findUnique({
    where: {
      servicePrincipalId_idempotencyKey: {
        servicePrincipalId,
        idempotencyKey,
      },
    },
    select: {
      id: true,
      operationName: true,
      status: true,
      approval: {
        select: {
          id: true,
        },
      },
      auditEvents: {
        where: {
          eventType: {
            in: [...terminalEventTypes],
          },
        },
        orderBy: {
          occurredAt: 'desc',
        },
        take: 1,
        select: {
          id: true,
          resultSnapshotJson: true,
        },
      },
    },
  });
}

export interface RecordTerminalOperationInput {
  operationName: string;
  status: AdminOperationStatusValue;
  servicePrincipalId: string;
  operatorUserId: string | null;
  sourceChannel: string;
  idempotencyKey: string;
  correlationId: string | null;
  reason: string;
  ticketRef: string | null;
  targetProjectId: string;
  targetUserId: string | null;
  targetSessionId: string | null;
  policyVersion: string;
  errorCode: string | null;
  requestSnapshotJson: Prisma.InputJsonValue;
  resultSnapshotJson: Prisma.InputJsonValue;
  /**
   * When set, an existing (previously `FAILED`) operation is reused instead of
   * inserting a new row, so a retry with the same idempotency key re-executes
   * while keeping the append-only audit history of every attempt.
   */
  existingOperationId?: string;
}

/**
 * Persists the per-operation anchor plus its append-only milestone events
 * (`REQUESTED` then a terminal event). Runs on the provided client, so the
 * success path can share the same transaction as its side effects.
 */
export async function recordTerminalOperation(
  prisma: AdminOperationsDbClient,
  input: RecordTerminalOperationInput,
): Promise<{ operationId: string; auditEventId: string }> {
  const operation =
    input.existingOperationId === undefined
      ? await prisma.adminOperation.create({
          data: {
            operationName: input.operationName,
            status: input.status,
            servicePrincipalId: input.servicePrincipalId,
            operatorUserId: input.operatorUserId,
            sourceChannel: input.sourceChannel,
            idempotencyKey: input.idempotencyKey,
            correlationId: input.correlationId,
            reason: input.reason,
            ticketRef: input.ticketRef,
            targetProjectId: input.targetProjectId,
            targetUserId: input.targetUserId,
            targetSessionId: input.targetSessionId,
            policyVersion: input.policyVersion,
            errorCode: input.errorCode,
          },
          select: {
            id: true,
          },
        })
      : await prisma.adminOperation.update({
          where: {
            id: input.existingOperationId,
          },
          data: {
            status: input.status,
            operatorUserId: input.operatorUserId,
            sourceChannel: input.sourceChannel,
            correlationId: input.correlationId,
            reason: input.reason,
            ticketRef: input.ticketRef,
            targetUserId: input.targetUserId,
            targetSessionId: input.targetSessionId,
            policyVersion: input.policyVersion,
            errorCode: input.errorCode,
          },
          select: {
            id: true,
          },
        });

  await prisma.adminActionAudit.create({
    data: {
      operationId: operation.id,
      eventType: 'REQUESTED',
      actorUserId: input.operatorUserId,
      requestSnapshotJson: input.requestSnapshotJson,
    },
  });

  const terminalAudit = await prisma.adminActionAudit.create({
    data: {
      operationId: operation.id,
      eventType: terminalEventTypeByStatus[input.status],
      actorUserId: input.operatorUserId,
      resultSnapshotJson: input.resultSnapshotJson,
      errorCode: input.errorCode,
    },
    select: {
      id: true,
    },
  });

  return {
    operationId: operation.id,
    auditEventId: terminalAudit.id,
  };
}

const operationResponseSelect = {
  id: true,
  status: true,
  approval: {
    select: {
      id: true,
    },
  },
  auditEvents: {
    where: {
      eventType: {
        in: [...terminalEventTypes],
      },
    },
    orderBy: {
      occurredAt: 'desc',
    },
    take: 1,
    select: {
      id: true,
      resultSnapshotJson: true,
    },
  },
} satisfies Prisma.AdminOperationSelect;

export async function findOperationByIdForResponse(
  prisma: AdminOperationsDbClient,
  operationId: string,
) {
  return prisma.adminOperation.findUnique({
    where: {
      id: operationId,
    },
    select: operationResponseSelect,
  });
}

export interface RecordPendingApprovalOperationInput {
  operationName: string;
  servicePrincipalId: string;
  operatorUserId: string | null;
  sourceChannel: string;
  idempotencyKey: string;
  correlationId: string | null;
  reason: string;
  ticketRef: string | null;
  targetProjectId: string;
  targetUserId: string | null;
  targetSessionId: string | null;
  requestSnapshotJson: Prisma.InputJsonValue;
  pendingResultSnapshotJson: Prisma.InputJsonValue;
  pendingPayloadJson?: Prisma.InputJsonValue;
  policyVersion: string;
  requiredApprovalLevel: string;
  expiresAt: Date;
}

/**
 * Persists a high-risk operation that must wait for a second-operator decision:
 * an `AdminOperation` in `PENDING_APPROVAL`, its `REQUESTED`/`PENDING_APPROVAL`
 * audit milestones, and the live `AdminApproval` row. No side effects are applied.
 */
export async function recordPendingApprovalOperation(
  prisma: AdminOperationsDbClient,
  input: RecordPendingApprovalOperationInput,
): Promise<{ operationId: string; approvalId: string; auditEventId: string }> {
  const operation = await prisma.adminOperation.create({
    data: {
      operationName: input.operationName,
      status: 'PENDING_APPROVAL',
      servicePrincipalId: input.servicePrincipalId,
      operatorUserId: input.operatorUserId,
      sourceChannel: input.sourceChannel,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
      reason: input.reason,
      ticketRef: input.ticketRef,
      targetProjectId: input.targetProjectId,
      targetUserId: input.targetUserId,
      targetSessionId: input.targetSessionId,
      pendingPayloadJson: input.pendingPayloadJson,
      policyVersion: input.policyVersion,
    },
    select: {
      id: true,
    },
  });

  await prisma.adminActionAudit.create({
    data: {
      operationId: operation.id,
      eventType: 'REQUESTED',
      actorUserId: input.operatorUserId,
      requestSnapshotJson: input.requestSnapshotJson,
    },
  });

  const pendingAudit = await prisma.adminActionAudit.create({
    data: {
      operationId: operation.id,
      eventType: 'PENDING_APPROVAL',
      actorUserId: input.operatorUserId,
      resultSnapshotJson: input.pendingResultSnapshotJson,
    },
    select: {
      id: true,
    },
  });

  const approval = await prisma.adminApproval.create({
    data: {
      operationId: operation.id,
      status: 'PENDING',
      requestedByUserId: input.operatorUserId,
      requiredApprovalLevel: input.requiredApprovalLevel,
      expiresAt: input.expiresAt,
    },
    select: {
      id: true,
    },
  });

  return {
    operationId: operation.id,
    approvalId: approval.id,
    auditEventId: pendingAudit.id,
  };
}

export async function findApprovalForDecision(prisma: AdminOperationsDbClient, approvalId: string) {
  return prisma.adminApproval.findUnique({
    where: {
      id: approvalId,
    },
    select: {
      id: true,
      status: true,
      requestedByUserId: true,
      expiresAt: true,
      operation: {
        select: {
          id: true,
          operationName: true,
          status: true,
          targetProjectId: true,
          targetUserId: true,
          targetSessionId: true,
          pendingPayloadJson: true,
        },
      },
    },
  });
}

export type ProjectAdminOperationRecord = Awaited<
  ReturnType<typeof listAdminOperationsByProject>
>[number];

/**
 * Operations in a terminal state are safe to prune; `PENDING_APPROVAL` rows are
 * never pruned regardless of age, since they may still be actionable.
 */
export const PRUNABLE_OPERATION_STATUSES = ['COMPLETED', 'DENIED', 'FAILED'] as const;

function prunableWhere(olderThan: Date): Prisma.AdminOperationWhereInput {
  return {
    status: { in: [...PRUNABLE_OPERATION_STATUSES] },
    createdAt: { lt: olderThan },
  };
}

export async function countPrunableOperations(
  prisma: AdminOperationsDbClient,
  input: { olderThan: Date },
): Promise<number> {
  return prisma.adminOperation.count({ where: prunableWhere(input.olderThan) });
}

export type PrunableOperationRecord = Awaited<ReturnType<typeof findPrunableOperations>>[number];

export async function findPrunableOperations(
  prisma: AdminOperationsDbClient,
  input: { olderThan: Date },
) {
  return prisma.adminOperation.findMany({
    where: prunableWhere(input.olderThan),
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      operationName: true,
      status: true,
      servicePrincipalId: true,
      operatorUserId: true,
      sourceChannel: true,
      reason: true,
      ticketRef: true,
      targetProjectId: true,
      targetUserId: true,
      targetSessionId: true,
      correlationId: true,
      policyVersion: true,
      errorCode: true,
      createdAt: true,
      updatedAt: true,
      approval: {
        select: {
          id: true,
          status: true,
          requestedByUserId: true,
          approvedByUserId: true,
          requestedAt: true,
          decidedAt: true,
          decisionReason: true,
          expiresAt: true,
        },
      },
      auditEvents: {
        orderBy: { occurredAt: 'asc' },
        select: {
          id: true,
          eventType: true,
          occurredAt: true,
          actorUserId: true,
          detail: true,
          errorCode: true,
          requestSnapshotJson: true,
          resultSnapshotJson: true,
        },
      },
    },
  });
}

export async function deletePrunableOperations(
  prisma: AdminOperationsDbClient,
  input: { olderThan: Date },
): Promise<number> {
  const result = await prisma.adminOperation.deleteMany({ where: prunableWhere(input.olderThan) });
  return result.count;
}

export async function deleteAdminOperationsByIds(
  prisma: AdminOperationsDbClient,
  ids: readonly string[],
): Promise<number> {
  if (ids.length === 0) {
    return 0;
  }

  const result = await prisma.adminOperation.deleteMany({ where: { id: { in: [...ids] } } });
  return result.count;
}

export async function listAdminOperationsByProject(
  prisma: AdminOperationsDbClient,
  input: {
    projectId: string;
    limit: number;
    status?: AdminOperationStatusValue;
    operationName?: string;
    cursor?: {
      createdAt: Date;
      id: string;
    };
  },
) {
  const where: Prisma.AdminOperationWhereInput = {
    targetProjectId: input.projectId,
  };

  if (input.status !== undefined) {
    where.status = input.status;
  }

  if (input.operationName !== undefined) {
    where.operationName = input.operationName;
  }

  if (input.cursor !== undefined) {
    where.OR = [
      {
        createdAt: {
          lt: input.cursor.createdAt,
        },
      },
      {
        createdAt: input.cursor.createdAt,
        id: {
          lt: input.cursor.id,
        },
      },
    ];
  }

  return prisma.adminOperation.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: input.limit,
    select: {
      id: true,
      operationName: true,
      status: true,
      reason: true,
      ticketRef: true,
      sourceChannel: true,
      operatorUserId: true,
      servicePrincipalId: true,
      targetUserId: true,
      targetSessionId: true,
      correlationId: true,
      policyVersion: true,
      errorCode: true,
      createdAt: true,
      updatedAt: true,
      approval: {
        select: {
          id: true,
          status: true,
          requestedByUserId: true,
          approvedByUserId: true,
          requestedAt: true,
          decidedAt: true,
          expiresAt: true,
        },
      },
    },
  });
}

export async function listPendingApprovals(
  prisma: AdminOperationsDbClient,
  input: {
    limit: number;
    targetProjectId?: string;
    allowedProjectIds?: readonly string[];
    cursor?: {
      requestedAt: Date;
      id: string;
    };
  },
) {
  const operationFilter: Prisma.AdminOperationWhereInput = {};

  if (input.targetProjectId !== undefined) {
    operationFilter.targetProjectId = input.targetProjectId;
  } else if (input.allowedProjectIds !== undefined) {
    operationFilter.targetProjectId = {
      in: [...input.allowedProjectIds],
    };
  }

  const where: Prisma.AdminApprovalWhereInput = {
    status: 'PENDING',
    operation: {
      is: operationFilter,
    },
  };

  if (input.cursor !== undefined) {
    where.OR = [
      {
        requestedAt: {
          lt: input.cursor.requestedAt,
        },
      },
      {
        requestedAt: input.cursor.requestedAt,
        id: {
          lt: input.cursor.id,
        },
      },
    ];
  }

  return prisma.adminApproval.findMany({
    where,
    orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
    take: input.limit,
    select: {
      id: true,
      status: true,
      requiredApprovalLevel: true,
      requestedByUserId: true,
      requestedAt: true,
      expiresAt: true,
      operation: {
        select: {
          id: true,
          operationName: true,
          targetProjectId: true,
          targetUserId: true,
          reason: true,
        },
      },
    },
  });
}
