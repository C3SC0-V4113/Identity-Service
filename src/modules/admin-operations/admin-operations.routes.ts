import type { FastifyPluginCallback } from 'fastify';

import {
  getCorrelationIdFromRequest,
  requireServicePrincipalFromRequest,
} from './admin-operations.guards.js';
import {
  adminGetUserAccessQuerySchema,
  adminListPendingApprovalsQuerySchema,
  adminListProjectUsersQuerySchema,
  adminUserIdParamsSchema,
  createUserOperationSchema,
} from './admin-operations.schemas.js';
import {
  createUserOperation,
  getUserAccessStatusOperation,
  listPendingApprovalsOperation,
  listProjectUsersOperation,
} from './admin-operations.services.js';

export const adminOperationsRoutes: FastifyPluginCallback = (app, _options, done) => {
  app.post('/admin/users', async (request, reply) => {
    const principal = await requireServicePrincipalFromRequest(app.prisma, request);
    const body = createUserOperationSchema.parse(request.body);
    const correlationId = getCorrelationIdFromRequest(request) ?? null;

    const result = await createUserOperation(app.prisma, principal, body, correlationId);

    return reply.status(200).send(result);
  });

  app.get('/admin/users', async (request, reply) => {
    const principal = await requireServicePrincipalFromRequest(app.prisma, request);
    const query = adminListProjectUsersQuerySchema.parse(request.query);

    const result = await listProjectUsersOperation(app.prisma, principal, query);

    return reply.status(200).send(result);
  });

  app.get('/admin/users/:userId/access', async (request, reply) => {
    const principal = await requireServicePrincipalFromRequest(app.prisma, request);
    const params = adminUserIdParamsSchema.parse(request.params);
    const query = adminGetUserAccessQuerySchema.parse(request.query);

    const result = await getUserAccessStatusOperation(app.prisma, principal, {
      userId: params.userId,
      query,
    });

    return reply.status(200).send(result);
  });

  app.get('/admin/approvals', async (request, reply) => {
    const principal = await requireServicePrincipalFromRequest(app.prisma, request);
    const query = adminListPendingApprovalsQuerySchema.parse(request.query);

    const result = await listPendingApprovalsOperation(app.prisma, principal, query);

    return reply.status(200).send(result);
  });

  done();
};
