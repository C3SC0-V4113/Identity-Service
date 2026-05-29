import argon2 from 'argon2';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';
import { bootstrapProjectAdminMemberships } from './project-admin-bootstrap.js';
import { upsertProjectSeedData } from './project-seed.js';

describe('bootstrapProjectAdminMemberships', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
  });

  beforeEach(async () => {
    await clearIdentityData();
    await upsertProjectSeedData(app.prisma);
  });

  afterAll(async () => {
    await clearIdentityData();
    await app.close();
  });

  it('ensures active admin memberships for multiple seeded projects', async () => {
    const user = await createUser({
      email: 'admin@example.com',
      password: 'supersecret',
    });

    const firstRun = await bootstrapProjectAdminMemberships(app.prisma, {
      email: user.email,
      projectSlugs: ['other-gpt', 'cost-console'],
    });

    const secondRun = await bootstrapProjectAdminMemberships(app.prisma, {
      email: 'ADMIN@example.com',
      projectSlugs: ['other-gpt', 'cost-console'],
    });

    expect(firstRun.user.id).toBe(user.id);
    expect(secondRun.memberships).toHaveLength(2);
    expect(secondRun.memberships).toMatchObject([
      {
        status: 'ACTIVE',
        project: {
          slug: 'other-gpt',
        },
        membershipRoles: [{ role: { code: 'admin' } }],
      },
      {
        status: 'ACTIVE',
        project: {
          slug: 'cost-console',
        },
        membershipRoles: [{ role: { code: 'admin' } }],
      },
    ]);

    const persistedMemberships = await app.prisma.projectMembership.findMany({
      where: {
        userId: user.id,
      },
      include: {
        membershipRoles: true,
      },
    });

    expect(persistedMemberships).toHaveLength(2);
    expect(
      persistedMemberships.every(
        (membership: (typeof persistedMemberships)[number]) => membership.status === 'ACTIVE',
      ),
    ).toBe(true);
    expect(
      persistedMemberships.every(
        (membership: (typeof persistedMemberships)[number]) =>
          membership.membershipRoles.length === 1,
      ),
    ).toBe(true);

    const persistedAdminRoleAssignments = await app.prisma.projectMembershipRole.findMany();
    expect(persistedAdminRoleAssignments).toHaveLength(2);
  });

  async function clearIdentityData() {
    await app.prisma.projectMembershipRole.deleteMany();
    await app.prisma.projectMembership.deleteMany();
    await app.prisma.session.deleteMany();
    await app.prisma.localCredential.deleteMany();
    await app.prisma.user.deleteMany();
  }

  async function createUser(input: { email: string; password: string }) {
    const passwordHash = await argon2.hash(input.password);

    return app.prisma.user.create({
      data: {
        email: input.email,
        emailNormalized: input.email.toLowerCase(),
        localCredential: {
          create: {
            passwordHash,
          },
        },
      },
    });
  }
});
