import { describe, expect, it } from 'vitest';

import { seedProjects } from './project-seed-data.js';

describe('seedProjects', () => {
  it('defines the expected bootstrap projects and role codes', () => {
    expect(seedProjects).toHaveLength(2);

    expect(seedProjects).toMatchObject([
      {
        slug: 'other-gpt',
        roles: [{ code: 'user' }, { code: 'pro' }, { code: 'admin' }],
      },
      {
        slug: 'cost-console',
        roles: [{ code: 'user' }, { code: 'admin' }],
      },
    ]);
  });

  it('keeps role codes unique inside each project', () => {
    for (const project of seedProjects) {
      const roleCodes = project.roles.map((role) => role.code);

      expect(new Set(roleCodes).size).toBe(roleCodes.length);
    }
  });

  it('allows shared role codes across different projects', () => {
    const roleProjects = new Map<string, string[]>();

    for (const project of seedProjects) {
      for (const role of project.roles) {
        const projects = roleProjects.get(role.code) ?? [];
        projects.push(project.slug);
        roleProjects.set(role.code, projects);
      }
    }

    expect(roleProjects.get('user')).toEqual(['other-gpt', 'cost-console']);
    expect(roleProjects.get('admin')).toEqual(['other-gpt', 'cost-console']);
    expect(roleProjects.get('pro')).toEqual(['other-gpt']);
  });
});
