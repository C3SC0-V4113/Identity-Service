import { describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';

describe('GET /health', () => {
  it('returns service health', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      service: 'identity-service',
    });
  });
});
