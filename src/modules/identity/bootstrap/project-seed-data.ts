export interface SeedProjectRoleDefinition {
  code: string;
  name: string;
  description: string;
  documentedPermissions: readonly string[];
}

export interface SeedProjectDefinition {
  slug: string;
  name: string;
  roles: readonly SeedProjectRoleDefinition[];
}

export const seedProjects: readonly SeedProjectDefinition[] = [
  {
    slug: 'other-gpt',
    name: 'Other GPT',
    roles: [
      {
        code: 'user',
        name: 'User',
        description: 'Standard signed-in user with baseline access to the product.',
        documentedPermissions: [
          'Use the standard product experience.',
          'Access personal conversation and workspace data allowed by the app.',
        ],
      },
      {
        code: 'pro',
        name: 'Pro',
        description: 'Paid or elevated user with access beyond the baseline user tier.',
        documentedPermissions: [
          'Includes all user capabilities.',
          'Access higher-tier features, limits, or premium model options defined by the app.',
        ],
      },
      {
        code: 'admin',
        name: 'Admin',
        description: 'Project-scoped administrator for operational and support actions.',
        documentedPermissions: [
          'Includes all pro capabilities.',
          'Manage project-scoped users, memberships, and administrative settings for Other GPT.',
        ],
      },
    ],
  },
  {
    slug: 'cost-console',
    name: 'Cost Console',
    roles: [
      {
        code: 'user',
        name: 'User',
        description: 'Standard product user with access to non-administrative cost views.',
        documentedPermissions: ['Access the standard cost and reporting views granted by the app.'],
      },
      {
        code: 'admin',
        name: 'Admin',
        description: 'Project-scoped administrator for the cost management application.',
        documentedPermissions: [
          'Includes all user capabilities.',
          'Manage cost-console administration, elevated views, and support workflows.',
        ],
      },
    ],
  },
];
