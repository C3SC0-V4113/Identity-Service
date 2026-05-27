import type { FastifyServerOptions } from 'fastify';

import { env } from '../../config/env.js';

export function createLoggerOptions(): FastifyServerOptions['logger'] {
  if (env.NODE_ENV === 'test') {
    return false;
  }

  if (env.NODE_ENV === 'development') {
    return {
      level: env.LOG_LEVEL,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
        },
      },
    };
  }

  return {
    level: env.LOG_LEVEL,
  };
}
