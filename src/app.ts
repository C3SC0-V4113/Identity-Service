import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';

import { healthRoutes } from './modules/health/health.routes.js';
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
    origin: false,
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });
  await app.register(requestContextPlugin);
  await app.register(healthRoutes);

  return app;
}
