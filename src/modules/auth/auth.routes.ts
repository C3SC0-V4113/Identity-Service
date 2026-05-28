import type { FastifyPluginCallback } from 'fastify';

import { authResponseSchema, loginRequestSchema, registerRequestSchema } from './auth.schemas.js';
import {
  getAuthenticatedUser,
  getSessionTokenFromCookie,
  loginUser,
  logoutUser,
  registerUser,
} from './auth.services.js';
import { getSessionCookieName, getSessionCookieOptions } from './auth.cookies.js';

export const authRoutes: FastifyPluginCallback = (app, _options, done) => {
  app.post('/auth/register', async (request, reply) => {
    const body = registerRequestSchema.parse(request.body);
    const result = await registerUser(app.prisma, body, {
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });

    reply.setCookie(getSessionCookieName(), result.sessionToken, getSessionCookieOptions());

    return reply.status(201).send(authResponseSchema.parse(result.response));
  });

  app.post('/auth/login', async (request, reply) => {
    const body = loginRequestSchema.parse(request.body);
    const result = await loginUser(app.prisma, body, {
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });

    reply.setCookie(getSessionCookieName(), result.sessionToken, getSessionCookieOptions());

    return reply.status(200).send(authResponseSchema.parse(result.response));
  });

  app.post('/auth/logout', async (request, reply) => {
    const sessionToken = getSessionTokenFromCookie(request.cookies, getSessionCookieName());

    await logoutUser(app.prisma, sessionToken);

    reply.clearCookie(getSessionCookieName(), getSessionCookieOptions());

    return reply.status(204).send();
  });

  app.get('/auth/me', async (request, reply) => {
    const sessionToken = getSessionTokenFromCookie(request.cookies, getSessionCookieName());
    const result = await getAuthenticatedUser(app.prisma, sessionToken, {
      touchSession: true,
    });

    return reply.status(200).send(authResponseSchema.parse(result));
  });

  done();
};
