import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';

export function registerPrisma(app: FastifyInstance): void {
  const prisma = new PrismaClient();

  app.decorate('prisma', prisma);

  app.addHook('onClose', async (instance) => {
    await instance.prisma.$disconnect();
  });
}
