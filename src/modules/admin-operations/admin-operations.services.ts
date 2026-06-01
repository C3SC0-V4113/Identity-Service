import argon2 from 'argon2';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';

import type { Prisma, PrismaClient } from '../../shared/db/prisma-types.js';

import { normalizeEmail } from '../../shared/auth/email.js';
import {
  assertServicePrincipalProjectAccess,
  servicePrincipalCanAccessProject,
} from '../../shared/auth/service-principal-auth.js';
import type { AuthenticatedServicePrincipal } from '../../shared/auth/service-principal-auth.js';
import { AppError } from '../../shared/errors/app-error.js';
import {
  createMembershipWithRoles,
  findMembershipWithRolesByProjectAndUser,
  findProjectRolesByCodes,
  listMembershipsByProject,
} from '../project-memberships/project-memberships.repositories.js';
import type { AdminTargetProject } from './admin-operations.guards.js';
import { requireTargetProjectById } from './admin-operations.guards.js';
import {
  findApprovalForDecision,
  findOperationByIdForResponse,
  findOperationByIdempotency,
  listPendingApprovals,
  recordPendingApprovalOperation,
  recordTerminalOperation,
} from './admin-operations.repositories.js';
import type { AdminOperationStatusValue } from './admin-operations.repositories.js';
import type {
  AdminGetUserAccessQuery,
  AdminListPendingApprovalsQuery,
  AdminListProjectUsersQuery,
  AdminMutationEnvelope,
  AdminMutationResponse,
  AdminOperationResponseStatus,
  BanUserOperationRequest,
  CreateUserOperationRequest,
  DecideApprovalRequest,
  UnbanUserOperationRequest,
} from './admin-operations.schemas.js';

const responseStatusByOperationStatus: Record<
  AdminOperationStatusValue,
  AdminOperationResponseStatus
> = {
  COMPLETED: 'completed',
  PENDING_APPROVAL: 'pending_approval',
  DENIED: 'denied',
  FAILED: 'failed',
};

const approvalTtlMs = 24 * 60 * 60 * 1000;

interface MutationExecuteResult {
  result: unknown;
  message: string;
  targetUserId?: string | null;
  targetSessionId?: string | null;
}

interface OperationContext {
  operationName: string;
  envelope: AdminMutationEnvelope;
  project: AdminTargetProject;
  correlationId: string | null;
}

interface ExecuteAdminMutationParams extends OperationContext {
  redactedPayload: unknown;
  execute: (tx: PrismaClient) => Promise<MutationExecuteResult>;
}

interface ApprovalGatedMutationParams extends OperationContext {
  redactedPayload: unknown;
  requiredApprovalLevel: string;
  pendingMessage: string;
  targetUserId?: string | null;
  targetSessionId?: string | null;
}

interface PendingOperationContext {
  id: string;
  operationName: string;
  targetProjectId: string | null;
  targetUserId: string | null;
  targetSessionId: string | null;
}

export async function createUserOperation(
  prisma: PrismaClient,
  principal: AuthenticatedServicePrincipal,
  request: CreateUserOperationRequest,
  correlationId: string | null,
): Promise<AdminMutationResponse> {
  const project = await requireTargetProjectById(prisma, request.targetProjectId);

  return executeAdminMutation(prisma, principal, {
    operationName: 'auth.createUser',
    envelope: request,
    project,
    correlationId,
    redactedPayload: {
      email: request.payload.email,
      displayName: request.payload.displayName ?? null,
      password: request.payload.password === undefined ? undefined : '[REDACTED]',
      roleCodes: request.payload.roleCodes ?? null,
    },
    execute: async (tx) => {
      const emailNormalized = normalizeEmail(request.payload.email);
      const existingUser = await tx.user.findUnique({
        where: { emailNormalized },
        select: { id: true },
      });

      if (existingUser !== null) {
        throw new AppError('User already exists', {
          statusCode: 409,
          code: 'USER_ALREADY_EXISTS',
        });
      }

      const roleCodes = [...new Set(request.payload.roleCodes ?? ['user'])];
      const roles = await findProjectRolesByCodes(tx, project.id, roleCodes);

      if (roles.length !== roleCodes.length) {
        throw new AppError('One or more project roles do not exist in this project', {
          statusCode: 400,
          code: 'PROJECT_ROLE_CODES_INVALID',
        });
      }

      const passwordHash =
        request.payload.password === undefined ? null : await argon2.hash(request.payload.password);

      const user = await tx.user.create({
        data: {
          email: request.payload.email.trim(),
          emailNormalized,
          displayName: request.payload.displayName ?? null,
          ...(passwordHash === null ? {} : { localCredential: { create: { passwordHash } } }),
        },
        select: { id: true, email: true, displayName: true },
      });

      const membership = await createMembershipWithRoles(tx, {
        projectId: project.id,
        userId: user.id,
        roleIds: roles.map((role) => role.id),
      });

      return {
        result: {
          user,
          membership: {
            id: membership.id,
            status: membership.status,
            roles: membership.membershipRoles.map((membershipRole) => membershipRole.role),
          },
        },
        message: 'User created and admitted to project',
        targetUserId: user.id,
      };
    },
  });
}

async function executeAdminMutation(
  prisma: PrismaClient,
  principal: AuthenticatedServicePrincipal,
  params: ExecuteAdminMutationParams,
): Promise<AdminMutationResponse> {
  const existing = await findOperationByIdempotency(
    prisma,
    principal.id,
    params.envelope.idempotencyKey,
  );

  let retryOperationId: string | undefined;

  if (existing !== null) {
    if (existing.operationName !== params.operationName) {
      throw idempotencyKeyReusedError();
    }

    // A FAILED operation applied no side effects, so a retry with the same key
    // re-executes (reusing the same operation row); any other status replays.
    if (existing.status !== 'FAILED') {
      return reconstructResponse(existing);
    }

    retryOperationId = existing.id;
  }

  const requestSnapshotJson = buildRequestSnapshot(params.envelope, params.redactedPayload);

  if (!servicePrincipalCanAccessProject(principal, params.project.id)) {
    return recordDeniedResponse(prisma, principal, params, requestSnapshotJson, retryOperationId);
  }

  try {
    return await prisma.$transaction(async (transactionClient: unknown) => {
      const tx = transactionClient as unknown as PrismaClient;
      const output = await params.execute(tx);
      const recorded = await recordTerminalOperation(tx as unknown as PrismaClient, {
        ...baseOperationFields(principal, params),
        status: 'COMPLETED',
        targetUserId: output.targetUserId ?? null,
        targetSessionId: output.targetSessionId ?? null,
        errorCode: null,
        requestSnapshotJson,
        resultSnapshotJson: {
          message: output.message,
          result: output.result,
        } as unknown as Prisma.InputJsonValue,
        existingOperationId: retryOperationId,
      });

      return {
        status: 'completed' as const,
        operationId: recorded.operationId,
        approvalId: null,
        auditEventId: recorded.auditEventId,
        message: output.message,
        result: output.result,
      };
    });
  } catch (error: unknown) {
    if (isOperationIdempotencyConflict(error)) {
      const raced = await findOperationByIdempotency(
        prisma,
        principal.id,
        params.envelope.idempotencyKey,
      );

      if (raced !== null) {
        return reconstructResponse(raced);
      }
    }

    if (!(error instanceof AppError)) {
      throw error;
    }

    const recorded = await recordTerminalOperation(prisma, {
      ...baseOperationFields(principal, params),
      status: 'FAILED',
      targetUserId: null,
      targetSessionId: null,
      errorCode: error.code,
      requestSnapshotJson,
      resultSnapshotJson: {
        message: error.message,
        result: null,
      } as unknown as Prisma.InputJsonValue,
      existingOperationId: retryOperationId,
    });

    return {
      status: 'failed',
      operationId: recorded.operationId,
      approvalId: null,
      auditEventId: recorded.auditEventId,
      message: error.message,
      result: null,
    };
  }
}

function baseOperationFields(principal: AuthenticatedServicePrincipal, ctx: OperationContext) {
  return {
    operationName: ctx.operationName,
    servicePrincipalId: principal.id,
    operatorUserId: ctx.envelope.operatorUserId ?? null,
    sourceChannel: ctx.envelope.channel,
    idempotencyKey: ctx.envelope.idempotencyKey,
    correlationId: ctx.correlationId,
    reason: ctx.envelope.reason,
    ticketRef: ctx.envelope.ticketRef ?? null,
    targetProjectId: ctx.project.id,
  };
}

async function recordDeniedResponse(
  prisma: PrismaClient,
  principal: AuthenticatedServicePrincipal,
  ctx: OperationContext,
  requestSnapshotJson: Prisma.InputJsonValue,
  existingOperationId?: string,
): Promise<AdminMutationResponse> {
  const message = 'Service principal is not allowed to target this project';
  const recorded = await recordTerminalOperation(prisma, {
    ...baseOperationFields(principal, ctx),
    status: 'DENIED',
    targetUserId: null,
    targetSessionId: null,
    errorCode: 'SERVICE_PRINCIPAL_PROJECT_FORBIDDEN',
    requestSnapshotJson,
    resultSnapshotJson: { message, result: null } as unknown as Prisma.InputJsonValue,
    existingOperationId,
  });

  return {
    status: 'denied',
    operationId: recorded.operationId,
    approvalId: null,
    auditEventId: recorded.auditEventId,
    message,
    result: null,
  };
}

/**
 * High-risk path: instead of executing now, records a `PENDING_APPROVAL`
 * operation plus its live `AdminApproval` and returns a `pending_approval`
 * envelope. The side effect runs later through `decideApprovalOperation`.
 */
async function runApprovalGatedMutation(
  prisma: PrismaClient,
  principal: AuthenticatedServicePrincipal,
  params: ApprovalGatedMutationParams,
): Promise<AdminMutationResponse> {
  const existing = await findOperationByIdempotency(
    prisma,
    principal.id,
    params.envelope.idempotencyKey,
  );

  if (existing !== null) {
    return replayExistingOperation(existing, params.operationName);
  }

  const requestSnapshotJson = buildRequestSnapshot(params.envelope, params.redactedPayload);

  if (!servicePrincipalCanAccessProject(principal, params.project.id)) {
    return recordDeniedResponse(prisma, principal, params, requestSnapshotJson);
  }

  const recorded = await recordPendingApprovalOperation(prisma, {
    ...baseOperationFields(principal, params),
    targetUserId: params.targetUserId ?? null,
    targetSessionId: params.targetSessionId ?? null,
    requestSnapshotJson,
    pendingResultSnapshotJson: {
      message: params.pendingMessage,
      result: null,
    } as unknown as Prisma.InputJsonValue,
    requiredApprovalLevel: params.requiredApprovalLevel,
    expiresAt: new Date(Date.now() + approvalTtlMs),
  });

  return {
    status: 'pending_approval',
    operationId: recorded.operationId,
    approvalId: recorded.approvalId,
    auditEventId: recorded.auditEventId,
    message: params.pendingMessage,
    result: null,
  };
}

type ApprovalExecutor = (
  tx: PrismaClient,
  operation: PendingOperationContext,
) => Promise<{ result: unknown; message: string }>;

const approvalExecutors: Record<string, ApprovalExecutor> = {
  'auth.banUser': async (tx, operation) => {
    if (operation.targetUserId === null) {
      throw new AppError('Operation is missing a target user', {
        statusCode: 500,
        code: 'ADMIN_OPERATION_TARGET_MISSING',
      });
    }

    const user = await tx.user.update({
      where: { id: operation.targetUserId },
      data: { status: 'BANNED', bannedAt: new Date() },
      select: { id: true, email: true, status: true },
    });

    return { result: { user }, message: 'User banned' };
  },
};

export async function banUserOperation(
  prisma: PrismaClient,
  principal: AuthenticatedServicePrincipal,
  request: BanUserOperationRequest,
  correlationId: string | null,
): Promise<AdminMutationResponse> {
  const project = await requireTargetProjectById(prisma, request.targetProjectId);

  const user = await prisma.user.findUnique({
    where: { id: request.payload.userId },
    select: { id: true },
  });

  if (user === null) {
    throw new AppError('User not found', {
      statusCode: 404,
      code: 'USER_NOT_FOUND',
    });
  }

  return runApprovalGatedMutation(prisma, principal, {
    operationName: 'auth.banUser',
    envelope: request,
    project,
    correlationId,
    redactedPayload: { userId: request.payload.userId },
    requiredApprovalLevel: 'confirmation',
    targetUserId: request.payload.userId,
    pendingMessage: 'Ban requested; awaiting confirmation',
  });
}

export async function unbanUserOperation(
  prisma: PrismaClient,
  principal: AuthenticatedServicePrincipal,
  request: UnbanUserOperationRequest,
  correlationId: string | null,
): Promise<AdminMutationResponse> {
  const project = await requireTargetProjectById(prisma, request.targetProjectId);

  return executeAdminMutation(prisma, principal, {
    operationName: 'auth.unbanUser',
    envelope: request,
    project,
    correlationId,
    redactedPayload: { userId: request.payload.userId },
    execute: async (tx) => {
      const existing = await tx.user.findUnique({
        where: { id: request.payload.userId },
        select: { id: true },
      });

      if (existing === null) {
        throw new AppError('User not found', {
          statusCode: 404,
          code: 'USER_NOT_FOUND',
        });
      }

      const user = await tx.user.update({
        where: { id: request.payload.userId },
        data: { status: 'ACTIVE', bannedAt: null },
        select: { id: true, email: true, status: true },
      });

      return { result: { user }, message: 'User unbanned', targetUserId: user.id };
    },
  });
}

export async function decideApprovalOperation(
  prisma: PrismaClient,
  principal: AuthenticatedServicePrincipal,
  input: { approvalId: string; request: DecideApprovalRequest },
): Promise<AdminMutationResponse> {
  const approval = await findApprovalForDecision(prisma, input.approvalId);

  if (approval === null) {
    throw new AppError('Approval not found', {
      statusCode: 404,
      code: 'ADMIN_APPROVAL_NOT_FOUND',
    });
  }

  assertServicePrincipalProjectAccess(principal, approval.operation.targetProjectId ?? '');

  if (approval.status !== 'PENDING') {
    const resolved = await findOperationByIdForResponse(prisma, approval.operation.id);

    if (resolved !== null) {
      return reconstructResponse(resolved);
    }
  }

  if (approval.expiresAt.getTime() <= Date.now()) {
    return resolveExpiredApproval(prisma, approval.id, approval.operation.id);
  }

  if (input.request.decision === 'reject') {
    return rejectApproval(prisma, {
      approvalId: approval.id,
      operationId: approval.operation.id,
      operatorUserId: input.request.operatorUserId,
      decisionReason: input.request.decisionReason ?? null,
    });
  }

  const executor = approvalExecutors[approval.operation.operationName];

  if (executor === undefined) {
    throw new AppError('No executor registered for this operation', {
      statusCode: 500,
      code: 'ADMIN_OPERATION_EXECUTOR_MISSING',
    });
  }

  const operationContext: PendingOperationContext = approval.operation;

  try {
    return await prisma.$transaction(async (transactionClient: unknown) => {
      const tx = transactionClient as unknown as PrismaClient;
      const output = await executor(tx, operationContext);

      await tx.adminApproval.update({
        where: { id: approval.id },
        data: {
          status: 'APPROVED',
          approvedByUserId: input.request.operatorUserId,
          decidedAt: new Date(),
          decisionReason: input.request.decisionReason ?? null,
        },
      });

      await tx.adminOperation.update({
        where: { id: approval.operation.id },
        data: { status: 'COMPLETED' },
      });

      await tx.adminActionAudit.create({
        data: {
          operationId: approval.operation.id,
          eventType: 'APPROVED',
          actorUserId: input.request.operatorUserId,
          detail: input.request.decisionReason ?? null,
        },
      });

      const terminal = await tx.adminActionAudit.create({
        data: {
          operationId: approval.operation.id,
          eventType: 'COMPLETED',
          actorUserId: input.request.operatorUserId,
          resultSnapshotJson: {
            message: output.message,
            result: output.result,
          } as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      });

      return {
        status: 'completed' as const,
        operationId: approval.operation.id,
        approvalId: approval.id,
        auditEventId: terminal.id,
        message: output.message,
        result: output.result,
      };
    });
  } catch (error: unknown) {
    if (!(error instanceof AppError)) {
      throw error;
    }

    const terminal = await prisma.adminActionAudit.create({
      data: {
        operationId: approval.operation.id,
        eventType: 'FAILED',
        actorUserId: input.request.operatorUserId,
        errorCode: error.code,
        resultSnapshotJson: {
          message: error.message,
          result: null,
        } as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });

    await prisma.adminOperation.update({
      where: { id: approval.operation.id },
      data: { status: 'FAILED', errorCode: error.code },
    });

    return {
      status: 'failed',
      operationId: approval.operation.id,
      approvalId: approval.id,
      auditEventId: terminal.id,
      message: error.message,
      result: null,
    };
  }
}

async function rejectApproval(
  prisma: PrismaClient,
  input: {
    approvalId: string;
    operationId: string;
    operatorUserId: string;
    decisionReason: string | null;
  },
): Promise<AdminMutationResponse> {
  const message = input.decisionReason ?? 'Operation rejected by approver';

  const terminal = await prisma.$transaction(async (transactionClient: unknown) => {
    const tx = transactionClient as unknown as PrismaClient;

    await tx.adminApproval.update({
      where: { id: input.approvalId },
      data: {
        status: 'REJECTED',
        approvedByUserId: input.operatorUserId,
        decidedAt: new Date(),
        decisionReason: input.decisionReason,
      },
    });

    await tx.adminOperation.update({
      where: { id: input.operationId },
      data: { status: 'DENIED' },
    });

    await tx.adminActionAudit.create({
      data: {
        operationId: input.operationId,
        eventType: 'REJECTED',
        actorUserId: input.operatorUserId,
        detail: input.decisionReason,
      },
    });

    return tx.adminActionAudit.create({
      data: {
        operationId: input.operationId,
        eventType: 'DENIED',
        actorUserId: input.operatorUserId,
        resultSnapshotJson: { message, result: null } as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
  });

  return {
    status: 'denied',
    operationId: input.operationId,
    approvalId: input.approvalId,
    auditEventId: terminal.id,
    message,
    result: null,
  };
}

async function resolveExpiredApproval(
  prisma: PrismaClient,
  approvalId: string,
  operationId: string,
): Promise<AdminMutationResponse> {
  const message = 'Approval expired before a decision was made';

  const terminal = await prisma.$transaction(async (transactionClient: unknown) => {
    const tx = transactionClient as unknown as PrismaClient;

    await tx.adminApproval.update({
      where: { id: approvalId },
      data: { status: 'EXPIRED', decidedAt: new Date() },
    });

    await tx.adminOperation.update({
      where: { id: operationId },
      data: { status: 'DENIED', errorCode: 'ADMIN_APPROVAL_EXPIRED' },
    });

    return tx.adminActionAudit.create({
      data: {
        operationId,
        eventType: 'DENIED',
        errorCode: 'ADMIN_APPROVAL_EXPIRED',
        resultSnapshotJson: { message, result: null } as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
  });

  return {
    status: 'denied',
    operationId,
    approvalId,
    auditEventId: terminal.id,
    message,
    result: null,
  };
}

function buildRequestSnapshot(
  envelope: AdminMutationEnvelope,
  redactedPayload: unknown,
): Prisma.InputJsonValue {
  return {
    targetProjectId: envelope.targetProjectId,
    reason: envelope.reason,
    idempotencyKey: envelope.idempotencyKey,
    ticketRef: envelope.ticketRef ?? null,
    channel: envelope.channel,
    operatorUserId: envelope.operatorUserId ?? null,
    payload: redactedPayload,
  } as unknown as Prisma.InputJsonValue;
}

function idempotencyKeyReusedError(): AppError {
  return new AppError(
    'Idempotency key already used for a different operation; use a unique key per request',
    {
      statusCode: 409,
      code: 'ADMIN_IDEMPOTENCY_KEY_REUSED',
    },
  );
}

function replayExistingOperation(
  operation: {
    id: string;
    operationName: string;
    status: AdminOperationStatusValue;
    approval: { id: string } | null;
    auditEvents: Array<{ id: string; resultSnapshotJson: unknown }>;
  },
  expectedOperationName: string,
): AdminMutationResponse {
  if (operation.operationName !== expectedOperationName) {
    throw idempotencyKeyReusedError();
  }

  return reconstructResponse(operation);
}

function reconstructResponse(operation: {
  id: string;
  status: AdminOperationStatusValue;
  approval: { id: string } | null;
  auditEvents: Array<{ id: string; resultSnapshotJson: unknown }>;
}): AdminMutationResponse {
  const terminal = operation.auditEvents[0];
  const snapshot = (terminal?.resultSnapshotJson ?? null) as {
    message?: string;
    result?: unknown;
  } | null;

  return {
    status: responseStatusByOperationStatus[operation.status],
    operationId: operation.id,
    approvalId: operation.approval?.id ?? null,
    auditEventId: terminal?.id ?? operation.id,
    message: snapshot?.message ?? '',
    result: snapshot?.result ?? null,
  };
}

function isOperationIdempotencyConflict(error: unknown): boolean {
  if (!(error instanceof PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }

  const target = error.meta?.target;
  const values = Array.isArray(target) ? target : typeof target === 'string' ? [target] : [];

  return values.some((value) => typeof value === 'string' && value.includes('idempotency'));
}

export async function listProjectUsersOperation(
  prisma: PrismaClient,
  principal: AuthenticatedServicePrincipal,
  query: AdminListProjectUsersQuery,
) {
  const project = await requireTargetProjectById(prisma, query.targetProjectId);
  assertServicePrincipalProjectAccess(principal, project.id);

  const queryText = query.q?.trim();
  const records = await listMembershipsByProject(prisma, {
    projectId: project.id,
    limit: query.limit + 1,
    status: query.status,
    query:
      queryText === undefined
        ? undefined
        : { emailNormalized: queryText.toLowerCase(), displayName: queryText },
    cursor: query.cursor === undefined ? undefined : decodeListCursor(query.cursor),
  });

  const hasMore = records.length > query.limit;
  const pageItems = hasMore ? records.slice(0, query.limit) : records;
  const lastItem = pageItems.at(-1);

  return {
    project: { id: project.id, slug: project.slug, name: project.name },
    items: pageItems.map((membership) => ({
      membershipId: membership.id,
      user: membership.user,
      status: membership.status,
      roles: membership.membershipRoles.map((membershipRole) => membershipRole.role),
      createdAt: membership.createdAt.toISOString(),
      updatedAt: membership.updatedAt.toISOString(),
    })),
    page: {
      nextCursor:
        hasMore && lastItem !== undefined
          ? encodeListCursor(lastItem.createdAt, lastItem.id)
          : null,
      hasMore,
      limit: query.limit,
    },
  };
}

export async function getUserAccessStatusOperation(
  prisma: PrismaClient,
  principal: AuthenticatedServicePrincipal,
  input: { userId: string; query: AdminGetUserAccessQuery },
) {
  const project = await requireTargetProjectById(prisma, input.query.targetProjectId);
  assertServicePrincipalProjectAccess(principal, project.id);

  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true, email: true, displayName: true, status: true },
  });

  if (user === null) {
    throw new AppError('User not found', {
      statusCode: 404,
      code: 'USER_NOT_FOUND',
    });
  }

  const membership = await findMembershipWithRolesByProjectAndUser(
    prisma,
    project.id,
    input.userId,
  );
  const roles =
    membership === null
      ? []
      : membership.membershipRoles.map((membershipRole) => membershipRole.role);

  return {
    project: { id: project.id, slug: project.slug, name: project.name },
    user,
    access: {
      isMember: membership !== null,
      membershipId: membership?.id ?? null,
      status: membership?.status ?? null,
      roles,
      isAdmin: membership?.status === 'ACTIVE' && roles.some((role) => role.code === 'admin'),
    },
  };
}

export async function listPendingApprovalsOperation(
  prisma: PrismaClient,
  principal: AuthenticatedServicePrincipal,
  query: AdminListPendingApprovalsQuery,
) {
  let targetProjectId: string | undefined;

  if (query.targetProjectId !== undefined) {
    const project = await requireTargetProjectById(prisma, query.targetProjectId);
    assertServicePrincipalProjectAccess(principal, project.id);
    targetProjectId = project.id;
  }

  const records = await listPendingApprovals(prisma, {
    limit: query.limit + 1,
    targetProjectId,
    allowedProjectIds:
      targetProjectId !== undefined || principal.allProjects
        ? undefined
        : principal.scopedProjectIds,
    cursor: query.cursor === undefined ? undefined : decodeApprovalCursor(query.cursor),
  });

  const hasMore = records.length > query.limit;
  const pageItems = hasMore ? records.slice(0, query.limit) : records;
  const lastItem = pageItems.at(-1);

  return {
    items: pageItems.map((approval) => ({
      approvalId: approval.id,
      status: approval.status,
      requiredApprovalLevel: approval.requiredApprovalLevel,
      requestedByUserId: approval.requestedByUserId,
      requestedAt: approval.requestedAt.toISOString(),
      expiresAt: approval.expiresAt.toISOString(),
      operation: approval.operation,
    })),
    page: {
      nextCursor:
        hasMore && lastItem !== undefined
          ? encodeApprovalCursor(lastItem.requestedAt, lastItem.id)
          : null,
      hasMore,
      limit: query.limit,
    },
  };
}

function decodeListCursor(cursor: string): { createdAt: Date; id: string } {
  const decoded = decodeCursor(cursor);
  return { createdAt: decoded.date, id: decoded.id };
}

function decodeApprovalCursor(cursor: string): { requestedAt: Date; id: string } {
  const decoded = decodeCursor(cursor);
  return { requestedAt: decoded.date, id: decoded.id };
}

function encodeListCursor(createdAt: Date, id: string): string {
  return encodeCursor(createdAt, id);
}

function encodeApprovalCursor(requestedAt: Date, id: string): string {
  return encodeCursor(requestedAt, id);
}

function encodeCursor(date: Date, id: string): string {
  return Buffer.from(JSON.stringify({ date: date.toISOString(), id }), 'utf8').toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): { date: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      date?: unknown;
      id?: unknown;
    };

    if (typeof parsed.date !== 'string' || typeof parsed.id !== 'string') {
      throw new Error('Invalid cursor payload');
    }

    const date = new Date(parsed.date);

    if (Number.isNaN(date.getTime()) || parsed.id.trim().length === 0) {
      throw new Error('Invalid cursor payload');
    }

    return { date, id: parsed.id };
  } catch {
    throw new AppError('Invalid pagination cursor', {
      statusCode: 400,
      code: 'ADMIN_OPERATION_CURSOR_INVALID',
    });
  }
}
