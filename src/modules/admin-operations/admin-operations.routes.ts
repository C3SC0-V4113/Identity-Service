import type { FastifyPluginCallback } from 'fastify';

import {
  getCorrelationIdFromRequest,
  requireServicePrincipalFromRequest,
} from './admin-operations.guards.js';
import {
  adminApprovalIdParamsSchema,
  adminGetUserAccessQuerySchema,
  adminListPendingApprovalsQuerySchema,
  adminListProjectUsersQuerySchema,
  adminUserIdParamsSchema,
  banUserOperationSchema,
  createUserOperationSchema,
  decideApprovalSchema,
  unbanUserOperationSchema,
} from './admin-operations.schemas.js';
import {
  banUserOperation,
  createUserOperation,
  decideApprovalOperation,
  getUserAccessStatusOperation,
  listPendingApprovalsOperation,
  listProjectUsersOperation,
  unbanUserOperation,
} from './admin-operations.services.js';

export const adminOperationsRoutes: FastifyPluginCallback = (app, _options, done) => {
  app.post('/admin/users', async (request, reply) => {
    const principal = await requireServicePrincipalFromRequest(app.prisma, request);
    const body = createUserOperationSchema.parse(request.body);
    const correlationId = getCorrelationIdFromRequest(request) ?? null;

    const result = await createUserOperation(app.prisma, principal, body, correlationId);

    return reply.status(200).send(result);
  });

  app.post('/admin/users/ban', async (request, reply) => {
    const principal = await requireServicePrincipalFromRequest(app.prisma, request);
    const body = banUserOperationSchema.parse(request.body);
    const correlationId = getCorrelationIdFromRequest(request) ?? null;

    const result = await banUserOperation(app.prisma, principal, body, correlationId);

    return reply.status(200).send(result);
  });

  app.post('/admin/users/unban', async (request, reply) => {
    const principal = await requireServicePrincipalFromRequest(app.prisma, request);
    const body = unbanUserOperationSchema.parse(request.body);
    const correlationId = getCorrelationIdFromRequest(request) ?? null;

    const result = await unbanUserOperation(app.prisma, principal, body, correlationId);

    return reply.status(200).send(result);
  });

  app.post('/admin/approvals/:approvalId/decide', async (request, reply) => {
    const principal = await requireServicePrincipalFromRequest(app.prisma, request);
    const params = adminApprovalIdParamsSchema.parse(request.params);
    const body = decideApprovalSchema.parse(request.body);

    const result = await decideApprovalOperation(app.prisma, principal, {
      approvalId: params.approvalId,
      request: body,
    });

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
