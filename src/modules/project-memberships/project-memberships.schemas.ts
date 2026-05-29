import { z } from 'zod';

export const membershipStatusSchema = z.enum(['ACTIVE', 'SUSPENDED', 'REVOKED']);

export const projectSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
});

export const projectRoleSummarySchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
});

export const projectMembershipUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
});

export const projectSlugParamsSchema = z.object({
  slug: z.string().trim().min(1),
});

export const projectMembershipParamsSchema = projectSlugParamsSchema.extend({
  userId: z.string().trim().min(1),
});

export const listProjectMembershipsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().trim().min(1).optional(),
  status: membershipStatusSchema.optional(),
  q: z.string().trim().min(1).optional(),
});

export const createProjectMembershipRequestSchema = z.object({
  email: z.string().trim().pipe(z.email()),
  roleCodes: z.array(z.string().trim().min(1)).min(1),
});

export const replaceProjectMembershipRolesRequestSchema = z.object({
  roleCodes: z.array(z.string().trim().min(1)).min(1),
});

export const projectAccessResponseSchema = z.object({
  project: projectSummarySchema,
  access: z.object({
    isMember: z.boolean(),
    membershipId: z.string().nullable(),
    status: membershipStatusSchema.nullable(),
    roles: z.array(projectRoleSummarySchema),
    isAdmin: z.boolean(),
  }),
});

export const projectMembershipResponseSchema = z.object({
  membershipId: z.string(),
  user: projectMembershipUserSchema,
  project: projectSummarySchema,
  status: membershipStatusSchema,
  roles: z.array(projectRoleSummarySchema),
});

export const projectMembershipListItemSchema = z.object({
  membershipId: z.string(),
  user: projectMembershipUserSchema,
  status: membershipStatusSchema,
  roles: z.array(projectRoleSummarySchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const projectMembershipListResponseSchema = z.object({
  project: projectSummarySchema,
  items: z.array(projectMembershipListItemSchema),
  page: z.object({
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
    limit: z.number().int().min(1).max(50),
  }),
});

export type ProjectSlugParams = z.infer<typeof projectSlugParamsSchema>;
export type ProjectMembershipParams = z.infer<typeof projectMembershipParamsSchema>;
export type ListProjectMembershipsQuery = z.infer<typeof listProjectMembershipsQuerySchema>;
export type CreateProjectMembershipRequest = z.infer<typeof createProjectMembershipRequestSchema>;
export type ReplaceProjectMembershipRolesRequest = z.infer<
  typeof replaceProjectMembershipRolesRequestSchema
>;
export type ProjectAccessResponse = z.infer<typeof projectAccessResponseSchema>;
export type ProjectMembershipResponse = z.infer<typeof projectMembershipResponseSchema>;
export type ProjectMembershipListResponse = z.infer<typeof projectMembershipListResponseSchema>;
