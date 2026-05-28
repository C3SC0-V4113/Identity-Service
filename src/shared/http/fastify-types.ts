import type { PrismaClient, Session, User } from '@prisma/client';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
  }

  interface FastifyRequest {
    auth?: {
      session: Session;
      user: User;
    };
  }
}

export {};
