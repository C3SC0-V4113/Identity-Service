import { bootstrapProjectAdminMemberships } from '../src/modules/identity/bootstrap/project-admin-bootstrap.js';
import { seedProjects } from '../src/modules/identity/bootstrap/project-seed-data.js';
import { createPrismaClient } from '../src/shared/db/prisma-client.js';

const prisma = createPrismaClient();

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.email === null) {
    throw new Error(
      'Missing required argument --email. Example: npm run db:bootstrap-admin -- --email admin@example.com --all-projects',
    );
  }

  const projectSlugs = args.allProjects
    ? seedProjects.map((project) => project.slug)
    : args.projects;

  if (projectSlugs.length === 0) {
    throw new Error(
      'Provide at least one --project <slug> or use --all-projects. Example: npm run db:bootstrap-admin -- --email admin@example.com --project other-gpt',
    );
  }

  const result = await bootstrapProjectAdminMemberships(prisma, {
    email: args.email,
    projectSlugs,
  });

  console.log(`Bootstrapped admin memberships for ${result.user.email}:`);

  for (const membership of result.memberships) {
    const roleCodes = membership.membershipRoles.map((membershipRole) => membershipRole.role.code);
    console.log(`- ${membership.project.slug}: ${membership.status} [${roleCodes.join(', ')}]`);
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error: unknown) => {
    console.error('Failed to bootstrap project admin memberships', error);
    await prisma.$disconnect();
    process.exit(1);
  });

function parseArgs(argv: string[]) {
  let email: string | null = null;
  const projects: string[] = [];
  let allProjects = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--email') {
      email = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (argument === '--project') {
      const projectSlug = argv[index + 1] ?? null;

      if (projectSlug !== null) {
        projects.push(projectSlug);
      }

      index += 1;
      continue;
    }

    if (argument === '--all-projects') {
      allProjects = true;
    }
  }

  return {
    email,
    projects,
    allProjects,
  };
}
