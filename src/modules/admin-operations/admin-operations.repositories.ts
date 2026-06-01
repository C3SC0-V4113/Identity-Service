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
  errorCode: string | null;
  requestSnapshotJson: Prisma.InputJsonValue;
  resultSnapshotJson: Prisma.InputJsonValue;
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
  const operation = await prisma.adminOperation.create({
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
