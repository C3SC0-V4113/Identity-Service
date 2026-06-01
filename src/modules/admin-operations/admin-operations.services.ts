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
  findOperationByIdempotency,
  listPendingApprovals,
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
  CreateUserOperationRequest,
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

interface MutationExecuteResult {
  result: unknown;
  message: string;
  targetUserId?: string | null;
  targetSessionId?: string | null;
}

interface ExecuteAdminMutationParams {
  operationName: string;
  envelope: AdminMutationEnvelope;
  project: AdminTargetProject;
  correlationId: string | null;
  redactedPayload: unknown;
  execute: (tx: PrismaClient) => Promise<MutationExecuteResult>;
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

  if (existing !== null) {
    return reconstructResponse(existing);
  }

  const requestSnapshotJson = buildRequestSnapshot(params.envelope, params.redactedPayload);

  if (!servicePrincipalCanAccessProject(principal, params.project.id)) {
    const message = 'Service principal is not allowed to target this project';
    const recorded = await recordTerminalOperation(prisma, {
      ...baseOperationFields(principal, params),
      status: 'DENIED',
      targetUserId: null,
      targetSessionId: null,
      errorCode: 'SERVICE_PRINCIPAL_PROJECT_FORBIDDEN',
      requestSnapshotJson,
      resultSnapshotJson: { message, result: null } as unknown as Prisma.InputJsonValue,
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

function baseOperationFields(
  principal: AuthenticatedServicePrincipal,
  params: ExecuteAdminMutationParams,
) {
  return {
    operationName: params.operationName,
    servicePrincipalId: principal.id,
    operatorUserId: params.envelope.operatorUserId ?? null,
    sourceChannel: params.envelope.channel,
    idempotencyKey: params.envelope.idempotencyKey,
    correlationId: params.correlationId,
    reason: params.envelope.reason,
    ticketRef: params.envelope.ticketRef ?? null,
    targetProjectId: params.project.id,
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
