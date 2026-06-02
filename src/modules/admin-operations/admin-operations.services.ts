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
  revokeActiveSessionByIdForProject,
  revokeActiveSessionsForUserInProject,
} from '../auth/auth.repositories.js';
import {
  createMembershipWithRoles,
  findMembershipWithRolesByProjectAndUser,
  findProjectRolesByCodes,
  listMembershipsByProject,
  replaceMembershipRoles,
  updateMembershipStatus,
} from '../project-memberships/project-memberships.repositories.js';
import {
  ensureActiveAdminRemainsAfterRoleReplacement,
  ensureActiveAdminRemainsAfterStatusChange,
} from '../project-memberships/project-memberships.services.js';
import type { AdminTargetProject } from './admin-operations.guards.js';
import { requireTargetProjectById } from './admin-operations.guards.js';
import { classifyOperationRisk } from './admin-operations.policy.js';
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
  AssignProjectRoleOperationRequest,
  BanUserOperationRequest,
  CreateUserOperationRequest,
  DecideApprovalRequest,
  ReadmitMembershipOperationRequest,
  RevokeProjectAccessOperationRequest,
  RevokeSessionOperationRequest,
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
  policyVersion: string;
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
  pendingPayloadJson?: unknown;
}

interface PendingOperationContext {
  id: string;
  operationName: string;
  targetProjectId: string | null;
  targetUserId: string | null;
  targetSessionId: string | null;
  pendingPayloadJson: unknown;
}

export async function createUserOperation(
  prisma: PrismaClient,
  principal: AuthenticatedServicePrincipal,
  request: CreateUserOperationRequest,
  correlationId: string | null,
): Promise<AdminMutationResponse> {
  const project = await requireTargetProjectById(prisma, request.targetProjectId);
  const risk = classifyOperationRisk({ operationName: 'auth.createUser' });

  return executeAdminMutation(prisma, principal, {
    operationName: 'auth.createUser',
    envelope: request,
    project,
    correlationId,
    policyVersion: risk.policyVersion,
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
    policyVersion: ctx.policyVersion,
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
    pendingPayloadJson:
      params.pendingPayloadJson === undefined
        ? undefined
        : (params.pendingPayloadJson as Prisma.InputJsonValue),
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
  'auth.assignProjectRole': async (tx, operation) => {
    const result = await executeAssignProjectRole(tx, {
      projectId: requireOperationTargetProject(operation),
      userId: requireOperationTargetUser(operation),
      roleCodes: readRoleCodesFromPayload(operation.pendingPayloadJson) ?? [],
    });
    return { result: result.result, message: result.message };
  },
  'auth.readmitProjectMembership': async (tx, operation) => {
    const result = await executeReadmitMembership(tx, {
      projectId: requireOperationTargetProject(operation),
      userId: requireOperationTargetUser(operation),
      roleCodes: readRoleCodesFromPayload(operation.pendingPayloadJson),
    });
    return { result: result.result, message: result.message };
  },
  'auth.revokeSession': async (tx, operation) => {
    const result = await executeMassRevokeSessions(tx, {
      projectId: requireOperationTargetProject(operation),
      userId: requireOperationTargetUser(operation),
    });
    return { result: result.result, message: result.message };
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

  const risk = classifyOperationRisk({ operationName: 'auth.banUser' });

  return runApprovalGatedMutation(prisma, principal, {
    operationName: 'auth.banUser',
    envelope: request,
    project,
    correlationId,
    policyVersion: risk.policyVersion,
    redactedPayload: { userId: request.payload.userId },
    requiredApprovalLevel: risk.requiredApprovalLevel,
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
  const risk = classifyOperationRisk({ operationName: 'auth.unbanUser' });

  return executeAdminMutation(prisma, principal, {
    operationName: 'auth.unbanUser',
    envelope: request,
    project,
    correlationId,
    policyVersion: risk.policyVersion,
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

export async function assignProjectRoleOperation(
  prisma: PrismaClient,
  principal: AuthenticatedServicePrincipal,
  request: AssignProjectRoleOperationRequest,
  correlationId: string | null,
): Promise<AdminMutationResponse> {
  const project = await requireTargetProjectById(prisma, request.targetProjectId);
  const roleCodes = request.payload.roleCodes;
  const redactedPayload = { userId: request.payload.userId, roleCodes };
  const risk = classifyOperationRisk({
    operationName: 'auth.assignProjectRole',
    assignsAdminRole: roleCodes.includes('admin'),
  });

  if (risk.highRisk) {
    return runApprovalGatedMutation(prisma, principal, {
      operationName: 'auth.assignProjectRole',
      envelope: request,
      project,
      correlationId,
      policyVersion: risk.policyVersion,
      redactedPayload,
      requiredApprovalLevel: risk.requiredApprovalLevel,
      targetUserId: request.payload.userId,
      pendingPayloadJson: { roleCodes },
      pendingMessage: 'Admin role assignment requested; awaiting confirmation',
    });
  }

  return executeAdminMutation(prisma, principal, {
    operationName: 'auth.assignProjectRole',
    envelope: request,
    project,
    correlationId,
    policyVersion: risk.policyVersion,
    redactedPayload,
    execute: (tx) =>
      executeAssignProjectRole(tx, {
        projectId: project.id,
        userId: request.payload.userId,
        roleCodes,
      }),
  });
}

export async function revokeProjectAccessOperation(
  prisma: PrismaClient,
  principal: AuthenticatedServicePrincipal,
  request: RevokeProjectAccessOperationRequest,
  correlationId: string | null,
): Promise<AdminMutationResponse> {
  const project = await requireTargetProjectById(prisma, request.targetProjectId);
  const risk = classifyOperationRisk({ operationName: 'auth.revokeProjectAccess' });

  return executeAdminMutation(prisma, principal, {
    operationName: 'auth.revokeProjectAccess',
    envelope: request,
    project,
    correlationId,
    policyVersion: risk.policyVersion,
    redactedPayload: { userId: request.payload.userId },
    execute: (tx) =>
      executeRevokeProjectAccess(tx, { projectId: project.id, userId: request.payload.userId }),
  });
}

export async function readmitMembershipOperation(
  prisma: PrismaClient,
  principal: AuthenticatedServicePrincipal,
  request: ReadmitMembershipOperationRequest,
  correlationId: string | null,
): Promise<AdminMutationResponse> {
  const project = await requireTargetProjectById(prisma, request.targetProjectId);
  const risk = classifyOperationRisk({ operationName: 'auth.readmitProjectMembership' });

  return runApprovalGatedMutation(prisma, principal, {
    operationName: 'auth.readmitProjectMembership',
    envelope: request,
    project,
    correlationId,
    policyVersion: risk.policyVersion,
    redactedPayload: {
      userId: request.payload.userId,
      roleCodes: request.payload.roleCodes ?? null,
    },
    requiredApprovalLevel: risk.requiredApprovalLevel,
    targetUserId: request.payload.userId,
    pendingPayloadJson: { roleCodes: request.payload.roleCodes ?? null },
    pendingMessage: 'Membership readmission requested; awaiting confirmation',
  });
}

export async function revokeSessionOperation(
  prisma: PrismaClient,
  principal: AuthenticatedServicePrincipal,
  request: RevokeSessionOperationRequest,
  correlationId: string | null,
): Promise<AdminMutationResponse> {
  const project = await requireTargetProjectById(prisma, request.targetProjectId);

  // Revoking a single session is low risk; a mass (per-user) revoke is high risk.
  if (request.payload.sessionId !== undefined) {
    const sessionId = request.payload.sessionId;
    const risk = classifyOperationRisk({
      operationName: 'auth.revokeSession',
      massSessionRevoke: false,
    });
    return executeAdminMutation(prisma, principal, {
      operationName: 'auth.revokeSession',
      envelope: request,
      project,
      correlationId,
      policyVersion: risk.policyVersion,
      redactedPayload: { sessionId },
      execute: (tx) => executeRevokeSingleSession(tx, { projectId: project.id, sessionId }),
    });
  }

  if (request.payload.userId !== undefined) {
    const userId = request.payload.userId;
    const risk = classifyOperationRisk({
      operationName: 'auth.revokeSession',
      massSessionRevoke: true,
    });
    return runApprovalGatedMutation(prisma, principal, {
      operationName: 'auth.revokeSession',
      envelope: request,
      project,
      correlationId,
      policyVersion: risk.policyVersion,
      redactedPayload: { userId },
      requiredApprovalLevel: risk.requiredApprovalLevel,
      targetUserId: userId,
      pendingMessage: 'Mass session revocation requested; awaiting confirmation',
    });
  }

  throw new AppError('Provide exactly one of sessionId or userId', {
    statusCode: 400,
    code: 'ADMIN_REVOKE_SESSION_TARGET_INVALID',
  });
}

const adminSessionRevokedReason = 'ADMIN_OPERATION_REVOKED';

function mapMembershipResult(membership: {
  id: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
  membershipRoles: Array<{ role: { id: string; code: string; name: string } }>;
}) {
  return {
    id: membership.id,
    status: membership.status,
    roles: membership.membershipRoles.map((membershipRole) => membershipRole.role),
  };
}

async function executeAssignProjectRole(
  tx: PrismaClient,
  input: { projectId: string; userId: string; roleCodes: readonly string[] },
): Promise<MutationExecuteResult> {
  const roleCodes = [...new Set(input.roleCodes)];

  if (roleCodes.length === 0) {
    throw new AppError('At least one project role is required', {
      statusCode: 400,
      code: 'PROJECT_ROLE_CODES_REQUIRED',
    });
  }

  const membership = await findMembershipWithRolesByProjectAndUser(
    tx,
    input.projectId,
    input.userId,
  );

  if (membership === null) {
    throw membershipNotFoundError();
  }

  const roles = await findProjectRolesByCodes(tx, input.projectId, roleCodes);

  if (roles.length !== roleCodes.length) {
    throw projectRolesInvalidError();
  }

  await ensureActiveAdminRemainsAfterRoleReplacement(tx, {
    projectId: input.projectId,
    membership,
    nextRoleCodes: roleCodes,
  });

  const updated = await replaceMembershipRoles(tx, {
    membershipId: membership.id,
    roleIds: roles.map((role) => role.id),
  });

  return {
    result: { membership: mapMembershipResult(updated) },
    message: 'Project roles updated',
    targetUserId: input.userId,
  };
}

async function executeRevokeProjectAccess(
  tx: PrismaClient,
  input: { projectId: string; userId: string },
): Promise<MutationExecuteResult> {
  const membership = await findMembershipWithRolesByProjectAndUser(
    tx,
    input.projectId,
    input.userId,
  );

  if (membership === null) {
    throw membershipNotFoundError();
  }

  if (membership.status === 'REVOKED') {
    throw new AppError('Cannot revoke a membership that is already revoked', {
      statusCode: 409,
      code: 'PROJECT_MEMBERSHIP_STATUS_TRANSITION_INVALID',
    });
  }

  await ensureActiveAdminRemainsAfterStatusChange(tx, {
    projectId: input.projectId,
    membership,
    nextStatus: 'REVOKED',
  });

  const updated = await updateMembershipStatus(tx, {
    membershipId: membership.id,
    status: 'REVOKED',
  });

  return {
    result: { membership: mapMembershipResult(updated) },
    message: 'Project access revoked',
    targetUserId: input.userId,
  };
}

async function executeReadmitMembership(
  tx: PrismaClient,
  input: { projectId: string; userId: string; roleCodes: readonly string[] | undefined },
): Promise<MutationExecuteResult> {
  const membership = await findMembershipWithRolesByProjectAndUser(
    tx,
    input.projectId,
    input.userId,
  );

  if (membership === null) {
    throw membershipNotFoundError();
  }

  if (membership.status !== 'REVOKED') {
    throw new AppError('Only revoked memberships can be readmitted', {
      statusCode: 409,
      code: 'PROJECT_MEMBERSHIP_NOT_REVOKED',
    });
  }

  const roleCodes = [...new Set(input.roleCodes ?? ['user'])];
  const roles = await findProjectRolesByCodes(tx, input.projectId, roleCodes);

  if (roles.length !== roleCodes.length) {
    throw projectRolesInvalidError();
  }

  await updateMembershipStatus(tx, { membershipId: membership.id, status: 'ACTIVE' });
  const updated = await replaceMembershipRoles(tx, {
    membershipId: membership.id,
    roleIds: roles.map((role) => role.id),
  });

  return {
    result: { membership: mapMembershipResult(updated) },
    message: 'Membership readmitted',
    targetUserId: input.userId,
  };
}

async function executeRevokeSingleSession(
  tx: PrismaClient,
  input: { projectId: string; sessionId: string },
): Promise<MutationExecuteResult> {
  const result = await revokeActiveSessionByIdForProject(tx, {
    sessionId: input.sessionId,
    projectId: input.projectId,
    revokedReason: adminSessionRevokedReason,
  });

  if (result.count === 0) {
    throw new AppError('Active session not found for this project', {
      statusCode: 404,
      code: 'SESSION_NOT_FOUND',
    });
  }

  return {
    result: { revokedCount: result.count },
    message: 'Session revoked',
    targetSessionId: input.sessionId,
  };
}

async function executeMassRevokeSessions(
  tx: PrismaClient,
  input: { projectId: string; userId: string },
): Promise<MutationExecuteResult> {
  const result = await revokeActiveSessionsForUserInProject(tx, {
    projectId: input.projectId,
    userId: input.userId,
    revokedReason: adminSessionRevokedReason,
  });

  return {
    result: { revokedCount: result.count },
    message: `Revoked ${result.count} active session(s)`,
    targetUserId: input.userId,
  };
}

function requireOperationTargetProject(operation: PendingOperationContext): string {
  if (operation.targetProjectId === null) {
    throw operationTargetMissingError();
  }
  return operation.targetProjectId;
}

function requireOperationTargetUser(operation: PendingOperationContext): string {
  if (operation.targetUserId === null) {
    throw operationTargetMissingError();
  }
  return operation.targetUserId;
}

function readRoleCodesFromPayload(pendingPayloadJson: unknown): string[] | undefined {
  if (pendingPayloadJson === null || typeof pendingPayloadJson !== 'object') {
    return undefined;
  }

  const roleCodes = (pendingPayloadJson as { roleCodes?: unknown }).roleCodes;

  if (!Array.isArray(roleCodes)) {
    return undefined;
  }

  return roleCodes.filter((code): code is string => typeof code === 'string');
}

function membershipNotFoundError(): AppError {
  return new AppError('Project membership not found', {
    statusCode: 404,
    code: 'PROJECT_MEMBERSHIP_NOT_FOUND',
  });
}

function projectRolesInvalidError(): AppError {
  return new AppError('One or more project roles do not exist in this project', {
    statusCode: 400,
    code: 'PROJECT_ROLE_CODES_INVALID',
  });
}

function operationTargetMissingError(): AppError {
  return new AppError('Operation is missing a required target', {
    statusCode: 500,
    code: 'ADMIN_OPERATION_TARGET_MISSING',
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
