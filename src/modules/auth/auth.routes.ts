import type { FastifyPluginCallback } from 'fastify';

import { getSessionTokenFromCookie } from '../../shared/auth/session-auth.js';
import { getSessionCookieName, getSessionCookieOptions } from './auth.cookies.js';
import {
  projectAuthLoginRequestSchema,
  projectAuthParamsSchema,
  projectAuthRegisterRequestSchema,
  projectAuthResponseSchema,
  projectSessionListQuerySchema,
  projectSessionListResponseSchema,
  projectSessionParamsSchema,
  registerEmailCheckRequestSchema,
  registerEmailCheckResponseSchema,
} from './auth.schemas.js';
import {
  checkRegistrationEmail,
  getAuthenticatedUser,
  listProjectSessionsForAdmin,
  loginUser,
  logoutUser,
  registerUser,
  revokeProjectSessionForAdmin,
  validateCurrentSession,
} from './auth.services.js';

export const authRoutes: FastifyPluginCallback = (app, _options, done) => {
  app.post('/projects/:slug/auth/register/email-check', async (request, reply) => {
    const params = projectAuthParamsSchema.parse(request.params);
    const body = registerEmailCheckRequestSchema.parse(request.body);
    const result = await checkRegistrationEmail(app.prisma, {
      projectSlug: params.slug,
      email: body.email,
    });

    return reply.status(200).send(registerEmailCheckResponseSchema.parse(result));
  });

  app.post('/projects/:slug/auth/register', async (request, reply) => {
    const params = projectAuthParamsSchema.parse(request.params);
    const body = projectAuthRegisterRequestSchema.parse(request.body);
    const result = await registerUser(
      app.prisma,
      {
        projectSlug: params.slug,
        body,
      },
      {
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      },
    );

    reply.setCookie(getSessionCookieName(), result.sessionToken, getSessionCookieOptions());

    return reply.status(201).send(projectAuthResponseSchema.parse(result.response));
  });

  app.post('/projects/:slug/auth/login', async (request, reply) => {
    const params = projectAuthParamsSchema.parse(request.params);
    const body = projectAuthLoginRequestSchema.parse(request.body);
    const result = await loginUser(
      app.prisma,
      {
        projectSlug: params.slug,
        body,
      },
      {
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      },
    );

    reply.setCookie(getSessionCookieName(), result.sessionToken, getSessionCookieOptions());

    return reply.status(200).send(projectAuthResponseSchema.parse(result.response));
  });

  app.post('/projects/:slug/auth/logout', async (request, reply) => {
    const params = projectAuthParamsSchema.parse(request.params);
    const sessionToken = getSessionTokenFromCookie(request.cookies, getSessionCookieName());

    await logoutUser(app.prisma, {
      projectSlug: params.slug,
      sessionToken,
    });

    reply.clearCookie(getSessionCookieName(), getSessionCookieOptions());

    return reply.status(204).send();
  });

  app.get('/projects/:slug/auth/me', async (request, reply) => {
    const params = projectAuthParamsSchema.parse(request.params);
    const sessionToken = getSessionTokenFromCookie(request.cookies, getSessionCookieName());
    const result = await getAuthenticatedUser(app.prisma, {
      projectSlug: params.slug,
      sessionToken,
      touchSession: true,
    });

    return reply.status(200).send(projectAuthResponseSchema.parse(result));
  });

  app.get('/projects/:slug/auth/session', async (request, reply) => {
    const params = projectAuthParamsSchema.parse(request.params);
    const sessionToken = getSessionTokenFromCookie(request.cookies, getSessionCookieName());

    await validateCurrentSession(app.prisma, {
      projectSlug: params.slug,
      sessionToken,
    });

    return reply.status(204).send();
  });

  app.get('/projects/:slug/sessions', async (request, reply) => {
    const params = projectAuthParamsSchema.parse(request.params);
    const query = projectSessionListQuerySchema.parse(request.query);
    const sessionToken = getSessionTokenFromCookie(request.cookies, getSessionCookieName());
    const result = await listProjectSessionsForAdmin(app.prisma, {
      projectSlug: params.slug,
      sessionToken,
      query,
    });

    return reply.status(200).send(projectSessionListResponseSchema.parse(result));
  });

  app.post('/projects/:slug/sessions/:sessionId/revoke', async (request, reply) => {
    const params = projectSessionParamsSchema.parse(request.params);
    const sessionToken = getSessionTokenFromCookie(request.cookies, getSessionCookieName());

    await revokeProjectSessionForAdmin(app.prisma, {
      projectSlug: params.slug,
      sessionToken,
      sessionId: params.sessionId,
    });

    return reply.status(204).send();
  });

  done();
};
