import type { FastifyInstance } from 'fastify';

import { createPrismaClient } from './prisma-client.js';

export function registerPrisma(app: FastifyInstance): void {
  const prisma = createPrismaClient();

  app.decorate('prisma', prisma);

  app.addHook('onClose', async (instance) => {
    await instance.prisma.$disconnect();
  });
}
