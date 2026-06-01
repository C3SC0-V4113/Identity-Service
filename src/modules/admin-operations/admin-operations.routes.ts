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
  assignProjectRoleOperationSchema,
  banUserOperationSchema,
  createUserOperationSchema,
  decideApprovalSchema,
  readmitMembershipOperationSchema,
  revokeProjectAccessOperationSchema,
  revokeSessionOperationSchema,
  unbanUserOperationSchema,
} from './admin-operations.schemas.js';
import {
  assignProjectRoleOperation,
  banUserOperation,
  createUserOperation,
  decideApprovalOperation,
  getUserAccessStatusOperation,
  listPendingApprovalsOperation,
  listProjectUsersOperation,
  readmitMembershipOperation,
  revokeProjectAccessOperation,
  revokeSessionOperation,
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

  app.post('/admin/memberships/roles', async (request, reply) => {
    const principal = await requireServicePrincipalFromRequest(app.prisma, request);
    const body = assignProjectRoleOperationSchema.parse(request.body);
    const correlationId = getCorrelationIdFromRequest(request) ?? null;

    const result = await assignProjectRoleOperation(app.prisma, principal, body, correlationId);

    return reply.status(200).send(result);
  });

  app.post('/admin/memberships/revoke', async (request, reply) => {
    const principal = await requireServicePrincipalFromRequest(app.prisma, request);
    const body = revokeProjectAccessOperationSchema.parse(request.body);
    const correlationId = getCorrelationIdFromRequest(request) ?? null;

    const result = await revokeProjectAccessOperation(app.prisma, principal, body, correlationId);

    return reply.status(200).send(result);
  });

  app.post('/admin/memberships/readmit', async (request, reply) => {
    const principal = await requireServicePrincipalFromRequest(app.prisma, request);
    const body = readmitMembershipOperationSchema.parse(request.body);
    const correlationId = getCorrelationIdFromRequest(request) ?? null;

    const result = await readmitMembershipOperation(app.prisma, principal, body, correlationId);

    return reply.status(200).send(result);
  });

  app.post('/admin/sessions/revoke', async (request, reply) => {
    const principal = await requireServicePrincipalFromRequest(app.prisma, request);
    const body = revokeSessionOperationSchema.parse(request.body);
    const correlationId = getCorrelationIdFromRequest(request) ?? null;

    const result = await revokeSessionOperation(app.prisma, principal, body, correlationId);

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
