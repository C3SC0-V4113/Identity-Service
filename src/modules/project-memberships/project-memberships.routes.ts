import type { FastifyPluginCallback } from 'fastify';

import {
  getSessionTokenFromCookie,
  requireAuthenticatedSession,
} from '../../shared/auth/session-auth.js';
import { getSessionCookieName } from '../auth/auth.cookies.js';
import {
  createProjectMembershipRequestSchema,
  listProjectMembershipsQuerySchema,
  projectAccessResponseSchema,
  projectMembershipListResponseSchema,
  projectMembershipParamsSchema,
  projectMembershipResponseSchema,
  projectSlugParamsSchema,
  replaceProjectMembershipRolesRequestSchema,
} from './project-memberships.schemas.js';
import {
  createProjectMembership,
  getProjectAccess,
  listProjectMemberships,
  reactivateProjectMembership,
  revokeProjectMembership,
  replaceProjectMembershipRoles,
  suspendProjectMembership,
} from './project-memberships.services.js';

export const projectMembershipRoutes: FastifyPluginCallback = (app, _options, done) => {
  app.get('/projects/:slug/me', async (request, reply) => {
    const params = projectSlugParamsSchema.parse(request.params);
    const authenticatedSession = await requireRequestAuth(request.cookies);

    const result = await getProjectAccess(app.prisma, {
      projectSlug: params.slug,
      userId: authenticatedSession.user.id,
    });

    return reply.status(200).send(projectAccessResponseSchema.parse(result));
  });

  app.get('/projects/:slug/memberships', async (request, reply) => {
    const params = projectSlugParamsSchema.parse(request.params);
    const query = listProjectMembershipsQuerySchema.parse(request.query);
    const authenticatedSession = await requireRequestAuth(request.cookies);

    const result = await listProjectMemberships(app.prisma, {
      actorUserId: authenticatedSession.user.id,
      projectSlug: params.slug,
      query,
    });

    return reply.status(200).send(projectMembershipListResponseSchema.parse(result));
  });

  app.post('/projects/:slug/memberships', async (request, reply) => {
    const params = projectSlugParamsSchema.parse(request.params);
    const body = createProjectMembershipRequestSchema.parse(request.body);
    const authenticatedSession = await requireRequestAuth(request.cookies);

    const result = await createProjectMembership(app.prisma, {
      actorUserId: authenticatedSession.user.id,
      projectSlug: params.slug,
      body,
    });

    return reply.status(201).send(projectMembershipResponseSchema.parse(result));
  });

  app.post('/projects/:slug/memberships/:userId/suspend', async (request, reply) => {
    const params = projectMembershipParamsSchema.parse(request.params);
    const authenticatedSession = await requireRequestAuth(request.cookies);

    const result = await suspendProjectMembership(app.prisma, {
      actorUserId: authenticatedSession.user.id,
      projectSlug: params.slug,
      targetUserId: params.userId,
    });

    return reply.status(200).send(projectMembershipResponseSchema.parse(result));
  });

  app.post('/projects/:slug/memberships/:userId/reactivate', async (request, reply) => {
    const params = projectMembershipParamsSchema.parse(request.params);
    const authenticatedSession = await requireRequestAuth(request.cookies);

    const result = await reactivateProjectMembership(app.prisma, {
      actorUserId: authenticatedSession.user.id,
      projectSlug: params.slug,
      targetUserId: params.userId,
    });

    return reply.status(200).send(projectMembershipResponseSchema.parse(result));
  });

  app.post('/projects/:slug/memberships/:userId/revoke', async (request, reply) => {
    const params = projectMembershipParamsSchema.parse(request.params);
    const authenticatedSession = await requireRequestAuth(request.cookies);

    const result = await revokeProjectMembership(app.prisma, {
      actorUserId: authenticatedSession.user.id,
      projectSlug: params.slug,
      targetUserId: params.userId,
    });

    return reply.status(200).send(projectMembershipResponseSchema.parse(result));
  });

  app.put('/projects/:slug/memberships/:userId/roles', async (request, reply) => {
    const params = projectMembershipParamsSchema.parse(request.params);
    const body = replaceProjectMembershipRolesRequestSchema.parse(request.body);
    const authenticatedSession = await requireRequestAuth(request.cookies);

    const result = await replaceProjectMembershipRoles(app.prisma, {
      actorUserId: authenticatedSession.user.id,
      projectSlug: params.slug,
      targetUserId: params.userId,
      body,
    });

    return reply.status(200).send(projectMembershipResponseSchema.parse(result));
  });

  done();

  function requireRequestAuth(cookies: Record<string, string | undefined>) {
    const sessionToken = getSessionTokenFromCookie(cookies, getSessionCookieName());
    return requireAuthenticatedSession(app.prisma, sessionToken);
  }
};
