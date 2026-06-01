import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';
import {
  assertServicePrincipalProjectAccess,
  getServicePrincipalTokenFromHeader,
  hashServicePrincipalToken,
  requireAuthenticatedServicePrincipal,
  servicePrincipalCanAccessProject,
} from '../../../shared/auth/service-principal-auth.js';
import { AppError } from '../../../shared/errors/app-error.js';
import { bootstrapServicePrincipal } from './service-principal-bootstrap.js';
import { upsertProjectSeedData } from './project-seed.js';

describe('service principal token helpers', () => {
  it('parses a bearer token from the Authorization header', () => {
    expect(getServicePrincipalTokenFromHeader('Bearer abc.def')).toBe('abc.def');
    expect(getServicePrincipalTokenFromHeader('bearer   abc.def')).toBe('abc.def');
  });

  it('returns null for missing or non-bearer headers', () => {
    expect(getServicePrincipalTokenFromHeader(undefined)).toBeNull();
    expect(getServicePrincipalTokenFromHeader('')).toBeNull();
    expect(getServicePrincipalTokenFromHeader('Basic abc')).toBeNull();
    expect(getServicePrincipalTokenFromHeader('Bearer')).toBeNull();
  });

  it('hashes tokens deterministically without echoing the plaintext', () => {
    const token = 'super-secret-token';
    const hash = hashServicePrincipalToken(token);

    expect(hash).toBe(hashServicePrincipalToken(token));
    expect(hash).not.toContain(token);
    expect(hash).toMatch(/^[a-f0-9]{64}$/u);
  });
});

describe('bootstrapServicePrincipal', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
  });

  beforeEach(async () => {
    await clearServicePrincipalData();
    await upsertProjectSeedData(app.prisma);
  });

  afterAll(async () => {
    await clearServicePrincipalData();
    await app.close();
  });

  it('creates a project-scoped principal whose token authenticates and respects the allow-list', async () => {
    const otherGpt = await getProjectBySlug('other-gpt');
    const costConsole = await getProjectBySlug('cost-console');

    const { token, servicePrincipal } = await bootstrapServicePrincipal(app.prisma, {
      slug: 'mcp-server',
      name: 'MCP Server',
      projectSlugs: ['other-gpt'],
    });

    expect(servicePrincipal.allProjects).toBe(false);
    expect(servicePrincipal.scopedProjectSlugs).toEqual(['other-gpt']);

    const authenticated = await requireAuthenticatedServicePrincipal(app.prisma, token);

    expect(authenticated.slug).toBe('mcp-server');
    expect(authenticated.allProjects).toBe(false);
    expect(authenticated.scopedProjectIds).toEqual([otherGpt.id]);

    expect(servicePrincipalCanAccessProject(authenticated, otherGpt.id)).toBe(true);
    expect(servicePrincipalCanAccessProject(authenticated, costConsole.id)).toBe(false);
    expect(() => {
      assertServicePrincipalProjectAccess(authenticated, otherGpt.id);
    }).not.toThrow();
    expect(() => {
      assertServicePrincipalProjectAccess(authenticated, costConsole.id);
    }).toThrow(AppError);
  });

  it('creates an all-projects principal that can target any project', async () => {
    const costConsole = await getProjectBySlug('cost-console');

    const { token, servicePrincipal } = await bootstrapServicePrincipal(app.prisma, {
      slug: 'openclaw-ops',
      name: 'OpenClaw Ops',
      allProjects: true,
      projectSlugs: ['other-gpt'],
    });

    expect(servicePrincipal.allProjects).toBe(true);
    expect(servicePrincipal.scopedProjectSlugs).toEqual([]);

    const authenticated = await requireAuthenticatedServicePrincipal(app.prisma, token);

    expect(authenticated.allProjects).toBe(true);
    expect(servicePrincipalCanAccessProject(authenticated, costConsole.id)).toBe(true);
  });

  it('rotates the secret on re-run, invalidating the previous token', async () => {
    const first = await bootstrapServicePrincipal(app.prisma, {
      slug: 'mcp-server',
      name: 'MCP Server',
      projectSlugs: ['other-gpt'],
    });

    const second = await bootstrapServicePrincipal(app.prisma, {
      slug: 'mcp-server',
      name: 'MCP Server Renamed',
      allProjects: true,
    });

    expect(second.token).not.toBe(first.token);
    expect(second.servicePrincipal.id).toBe(first.servicePrincipal.id);

    await expect(requireAuthenticatedServicePrincipal(app.prisma, first.token)).rejects.toThrow(
      expect.objectContaining({ code: 'SERVICE_PRINCIPAL_AUTH_REQUIRED' }),
    );

    const authenticated = await requireAuthenticatedServicePrincipal(app.prisma, second.token);
    expect(authenticated.name).toBe('MCP Server Renamed');
    expect(authenticated.allProjects).toBe(true);
    expect(authenticated.scopedProjectIds).toEqual([]);
  });

  it('rejects an unknown token and a disabled principal', async () => {
    const { token } = await bootstrapServicePrincipal(app.prisma, {
      slug: 'mcp-server',
      name: 'MCP Server',
      projectSlugs: ['other-gpt'],
    });

    await expect(
      requireAuthenticatedServicePrincipal(app.prisma, 'not-a-real-token'),
    ).rejects.toThrow(expect.objectContaining({ code: 'SERVICE_PRINCIPAL_AUTH_REQUIRED' }));

    await expect(requireAuthenticatedServicePrincipal(app.prisma, null)).rejects.toThrow(
      expect.objectContaining({ code: 'SERVICE_PRINCIPAL_AUTH_REQUIRED' }),
    );

    await app.prisma.servicePrincipal.update({
      where: { slug: 'mcp-server' },
      data: { status: 'DISABLED' },
    });

    await expect(requireAuthenticatedServicePrincipal(app.prisma, token)).rejects.toThrow(
      expect.objectContaining({ code: 'SERVICE_PRINCIPAL_DISABLED' }),
    );
  });

  it('fails when a requested project scope does not exist', async () => {
    await expect(
      bootstrapServicePrincipal(app.prisma, {
        slug: 'mcp-server',
        name: 'MCP Server',
        projectSlugs: ['does-not-exist'],
      }),
    ).rejects.toThrow(
      expect.objectContaining({ code: 'BOOTSTRAP_SERVICE_PRINCIPAL_PROJECT_NOT_FOUND' }),
    );
  });

  async function getProjectBySlug(slug: string) {
    return app.prisma.project.findUniqueOrThrow({
      where: { slug },
      select: { id: true, slug: true },
    });
  }

  async function clearServicePrincipalData() {
    await app.prisma.adminActionAudit.deleteMany();
    await app.prisma.adminApproval.deleteMany();
    await app.prisma.adminOperation.deleteMany();
    await app.prisma.servicePrincipalProjectScope.deleteMany();
    await app.prisma.servicePrincipal.deleteMany();
  }
});
