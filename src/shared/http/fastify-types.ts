import type { PrismaClient, Session, User } from '../db/prisma-types.js';

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
