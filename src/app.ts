import './shared/http/fastify-types.js';

import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';

import { env } from './config/env.js';
import { adminOperationsRoutes } from './modules/admin-operations/admin-operations.routes.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { projectMembershipRoutes } from './modules/project-memberships/project-memberships.routes.js';
import { registerPrisma } from './shared/db/prisma.js';
import { parseCorsOrigin } from './shared/http/cors.js';
import { registerErrorHandler } from './shared/http/error-handler.js';
import { requestContextPlugin } from './shared/http/request-context.js';
import { createLoggerOptions } from './shared/logging/logger.js';

export async function buildApp() {
  const app = Fastify({
    logger: createLoggerOptions(),
  });

  registerErrorHandler(app);

  await app.register(helmet);
  await app.register(cors, {
    origin: parseCorsOrigin(env.CORS_ORIGIN),
    credentials: env.CORS_CREDENTIALS,
  });
  await app.register(cookie);
  registerPrisma(app);
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });
  await app.register(requestContextPlugin);
  await app.register(authRoutes);
  await app.register(projectMembershipRoutes);
  await app.register(adminOperationsRoutes);
  await app.register(healthRoutes);

  return app;
}
