import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import { AppError } from '../errors/app-error.js';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(
    (error: FastifyError | AppError | ZodError, request: FastifyRequest, reply: FastifyReply) => {
      request.log.error({ error }, 'Request failed');

      if (error instanceof AppError) {
        void reply.status(error.statusCode).send({
          error: {
            code: error.code,
            message: error.message,
          },
        });
        return;
      }

      if (error instanceof ZodError) {
        void reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Request validation failed',
            issues: error.issues,
          },
        });
        return;
      }

      void reply.status(500).send({
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Unexpected server error',
        },
      });
    },
  );
}
