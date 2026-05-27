import type { FastifyPluginCallback } from 'fastify';

export const requestContextPlugin: FastifyPluginCallback = (app, _options, done) => {
  app.addHook('onRequest', (request, _reply, hookDone) => {
    request.log.debug({ requestId: request.id }, 'Request context initialized');
    hookDone();
  });

  done();
};
