import { z } from 'zod';

export const registerRequestSchema = z.object({
  email: z.string().trim().pipe(z.email()),
  password: z.string().min(8),
  displayName: z.string().trim().min(1).max(100).optional(),
});

export const loginRequestSchema = z.object({
  email: z.string().trim().pipe(z.email()),
  password: z.string().min(1),
});

export const roleResponseSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
});

export const membershipResponseSchema = z.object({
  id: z.string(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'REVOKED']),
  project: z.object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
  }),
  roles: z.array(roleResponseSchema),
});

export const authUserResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
  status: z.enum(['ACTIVE', 'BANNED']),
  createdAt: z.iso.datetime(),
  memberships: z.array(membershipResponseSchema),
});

export const authResponseSchema = z.object({
  user: authUserResponseSchema,
});

export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type AuthUserResponse = z.infer<typeof authUserResponseSchema>;
export type AuthResponse = z.infer<typeof authResponseSchema>;
