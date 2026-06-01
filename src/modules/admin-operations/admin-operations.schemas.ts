import { z } from 'zod';

/**
 * Common mutation envelope for the machine-to-machine admin surface (ADR 0008).
 * `mcp-server`/`openclaw-ops` send this on every mutating operation.
 */
export const adminMutationEnvelopeSchema = z.object({
  targetProjectId: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  idempotencyKey: z.string().trim().min(1),
  ticketRef: z.string().trim().min(1).optional(),
  channel: z.string().trim().min(1),
  operatorUserId: z.string().trim().min(1).optional(),
});

export type AdminMutationEnvelope = z.infer<typeof adminMutationEnvelopeSchema>;

export const createUserOperationSchema = adminMutationEnvelopeSchema.extend({
  payload: z.object({
    email: z.email(),
    displayName: z.string().trim().min(1).optional(),
    password: z.string().min(8).optional(),
    roleCodes: z.array(z.string().trim().min(1)).min(1).optional(),
  }),
});

export type CreateUserOperationRequest = z.infer<typeof createUserOperationSchema>;

export const banUserOperationSchema = adminMutationEnvelopeSchema.extend({
  payload: z.object({
    userId: z.string().trim().min(1),
  }),
});

export type BanUserOperationRequest = z.infer<typeof banUserOperationSchema>;

export const unbanUserOperationSchema = banUserOperationSchema;

export type UnbanUserOperationRequest = z.infer<typeof unbanUserOperationSchema>;

export const adminApprovalIdParamsSchema = z.object({
  approvalId: z.string().trim().min(1),
});

export const decideApprovalSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  operatorUserId: z.string().trim().min(1),
  decisionReason: z.string().trim().min(1).optional(),
});

export type DecideApprovalRequest = z.infer<typeof decideApprovalSchema>;

export const adminListProjectUsersQuerySchema = z.object({
  targetProjectId: z.string().trim().min(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().trim().min(1).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'REVOKED']).optional(),
  q: z.string().trim().min(1).optional(),
});

export type AdminListProjectUsersQuery = z.infer<typeof adminListProjectUsersQuerySchema>;

export const adminGetUserAccessQuerySchema = z.object({
  targetProjectId: z.string().trim().min(1),
});

export type AdminGetUserAccessQuery = z.infer<typeof adminGetUserAccessQuerySchema>;

export const adminUserIdParamsSchema = z.object({
  userId: z.string().trim().min(1),
});

export const adminListPendingApprovalsQuerySchema = z.object({
  targetProjectId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().trim().min(1).optional(),
});

export type AdminListPendingApprovalsQuery = z.infer<typeof adminListPendingApprovalsQuerySchema>;

export type AdminOperationResponseStatus = 'completed' | 'pending_approval' | 'denied' | 'failed';

export interface AdminMutationResponse {
  status: AdminOperationResponseStatus;
  operationId: string;
  approvalId: string | null;
  auditEventId: string;
  message: string;
  result: unknown;
}
