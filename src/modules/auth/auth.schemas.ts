import { z } from 'zod';

export const projectAuthParamsSchema = z.object({
  slug: z.string().trim().min(1),
});

export const projectSessionParamsSchema = projectAuthParamsSchema.extend({
  sessionId: z.string().trim().min(1),
});

export const registerEmailCheckRequestSchema = z.object({
  email: z.string().trim().pipe(z.email()),
});

export const registerEmailCheckResponseSchema = z.object({
  email: z.string(),
  exists: z.boolean(),
  nextStep: z.enum(['REGISTER', 'LOGIN']),
});

export const projectAuthRegisterRequestSchema = z.object({
  email: z.string().trim().pipe(z.email()),
  password: z.string().min(8),
  displayName: z.string().trim().min(1).max(100).optional(),
});

export const projectAuthLoginRequestSchema = z.object({
  email: z.string().trim().pipe(z.email()),
  password: z.string().min(1),
});

export const projectSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
});

export const roleResponseSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
});

export const projectAuthMembershipResponseSchema = z.object({
  id: z.string(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'REVOKED']),
  roles: z.array(roleResponseSchema),
});

export const projectAuthUserResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
  status: z.enum(['ACTIVE', 'BANNED']),
  createdAt: z.iso.datetime(),
});

export const projectAuthResponseSchema = z.object({
  user: projectAuthUserResponseSchema,
  project: projectSummarySchema,
  membership: projectAuthMembershipResponseSchema.nullable(),
});

export const projectSessionStatusSchema = z.enum(['ACTIVE', 'REVOKED', 'EXPIRED']);

export const projectSessionListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().trim().min(1).optional(),
  status: projectSessionStatusSchema.optional(),
  userId: z.string().trim().min(1).optional(),
  q: z.string().trim().min(1).optional(),
});

export const projectSessionUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
});

export const projectSessionSummarySchema = z.object({
  id: z.string(),
  status: projectSessionStatusSchema,
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  user: projectSessionUserSchema,
});

export const projectSessionListResponseSchema = z.object({
  project: projectSummarySchema,
  items: z.array(projectSessionSummarySchema),
  page: z.object({
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
    limit: z.number().int().min(1).max(50),
  }),
});

export type ProjectAuthParams = z.infer<typeof projectAuthParamsSchema>;
export type ProjectSessionParams = z.infer<typeof projectSessionParamsSchema>;
export type RegisterEmailCheckRequest = z.infer<typeof registerEmailCheckRequestSchema>;
export type RegisterEmailCheckResponse = z.infer<typeof registerEmailCheckResponseSchema>;
export type ProjectAuthRegisterRequest = z.infer<typeof projectAuthRegisterRequestSchema>;
export type ProjectAuthLoginRequest = z.infer<typeof projectAuthLoginRequestSchema>;
export type ProjectAuthResponse = z.infer<typeof projectAuthResponseSchema>;
export type ProjectSessionListQuery = z.infer<typeof projectSessionListQuerySchema>;
export type ProjectSessionListResponse = z.infer<typeof projectSessionListResponseSchema>;
