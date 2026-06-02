import type { PrismaClient } from '../../shared/db/prisma-types.js';

import { AppError } from '../../shared/errors/app-error.js';
import {
  countPrunableOperations,
  deleteAdminOperationsByIds,
  deletePrunableOperations,
  findPrunableOperations,
} from './admin-operations.repositories.js';
import type { PrunableOperationRecord } from './admin-operations.repositories.js';

export const DEFAULT_RETENTION_DAYS = 90;

const millisecondsPerDay = 24 * 60 * 60 * 1000;

export interface PruneAdminOperationsInput {
  retentionDays: number;
  dryRun: boolean;
  includeExport?: boolean;
  now?: Date;
}

export interface PruneAdminOperationsResult {
  retentionDays: number;
  cutoff: string;
  candidateCount: number;
  deletedCount: number;
  dryRun: boolean;
  exported: unknown[] | null;
}

/**
 * Retention/pruning for the admin audit trail (ADR 0008). Removes terminal
 * `AdminOperation` rows older than the retention window — cascading to their
 * `AdminActionAudit` and `AdminApproval` rows — while never touching
 * `PENDING_APPROVAL` operations. With `includeExport` the matching rows (full
 * audit history included) are returned so callers can archive before deleting.
 */
export async function pruneAdminOperations(
  prisma: PrismaClient,
  input: PruneAdminOperationsInput,
): Promise<PruneAdminOperationsResult> {
  if (!Number.isInteger(input.retentionDays) || input.retentionDays < 1) {
    throw new AppError('retentionDays must be a positive integer', {
      statusCode: 400,
      code: 'ADMIN_RETENTION_DAYS_INVALID',
    });
  }

  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - input.retentionDays * millisecondsPerDay);
  const includeExport = input.includeExport ?? false;

  // Fetch the full rows only when exporting; otherwise a count is enough.
  const candidates = includeExport
    ? await findPrunableOperations(prisma, { olderThan: cutoff })
    : [];
  const candidateCount = includeExport
    ? candidates.length
    : await countPrunableOperations(prisma, { olderThan: cutoff });

  let deletedCount = 0;

  if (!input.dryRun) {
    deletedCount = includeExport
      ? await deleteAdminOperationsByIds(
          prisma,
          candidates.map((operation) => operation.id),
        )
      : await deletePrunableOperations(prisma, { olderThan: cutoff });
  }

  return {
    retentionDays: input.retentionDays,
    cutoff: cutoff.toISOString(),
    candidateCount,
    deletedCount,
    dryRun: input.dryRun,
    exported: includeExport ? candidates.map(serializePrunedOperation) : null,
  };
}

function serializePrunedOperation(operation: PrunableOperationRecord) {
  return {
    operationId: operation.id,
    operationName: operation.operationName,
    status: operation.status,
    servicePrincipalId: operation.servicePrincipalId,
    operatorUserId: operation.operatorUserId,
    sourceChannel: operation.sourceChannel,
    reason: operation.reason,
    ticketRef: operation.ticketRef,
    targetProjectId: operation.targetProjectId,
    targetUserId: operation.targetUserId,
    targetSessionId: operation.targetSessionId,
    correlationId: operation.correlationId,
    policyVersion: operation.policyVersion,
    errorCode: operation.errorCode,
    createdAt: operation.createdAt.toISOString(),
    updatedAt: operation.updatedAt.toISOString(),
    approval:
      operation.approval === null
        ? null
        : {
            approvalId: operation.approval.id,
            status: operation.approval.status,
            requestedByUserId: operation.approval.requestedByUserId,
            approvedByUserId: operation.approval.approvedByUserId,
            requestedAt: operation.approval.requestedAt.toISOString(),
            decidedAt: operation.approval.decidedAt?.toISOString() ?? null,
            decisionReason: operation.approval.decisionReason,
            expiresAt: operation.approval.expiresAt.toISOString(),
          },
    auditEvents: operation.auditEvents.map((event) => ({
      auditEventId: event.id,
      eventType: event.eventType,
      occurredAt: event.occurredAt.toISOString(),
      actorUserId: event.actorUserId,
      detail: event.detail,
      errorCode: event.errorCode,
      requestSnapshotJson: event.requestSnapshotJson,
      resultSnapshotJson: event.resultSnapshotJson,
    })),
  };
}
