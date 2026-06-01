import { bootstrapServicePrincipal } from '../src/modules/identity/bootstrap/service-principal-bootstrap.js';
import { createPrismaClient } from '../src/shared/db/prisma-client.js';

const prisma = createPrismaClient();

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.slug === null) {
    throw new Error(
      'Missing required argument --slug. Example: npm run db:bootstrap-service-principal -- --slug openclaw-ops --name "OpenClaw Ops" --all-projects',
    );
  }

  const name = args.name ?? args.slug;

  if (!args.allProjects && args.projects.length === 0) {
    throw new Error(
      'Provide --all-projects or at least one --project <slug>. Example: npm run db:bootstrap-service-principal -- --slug mcp-server --name "MCP Server" --project other-gpt',
    );
  }

  const result = await bootstrapServicePrincipal(prisma, {
    slug: args.slug,
    name,
    description: args.description,
    allProjects: args.allProjects,
    projectSlugs: args.projects,
  });

  const scope = result.servicePrincipal.allProjects
    ? 'all projects'
    : `projects [${result.servicePrincipal.scopedProjectSlugs.join(', ')}]`;

  console.log(
    `Service principal "${result.servicePrincipal.slug}" (${result.servicePrincipal.status}) is ready for ${scope}.`,
  );
  console.log('');
  console.log('Bearer token (shown once, store it securely):');
  console.log(result.token);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error: unknown) => {
    console.error('Failed to bootstrap service principal', error);
    await prisma.$disconnect();
    process.exit(1);
  });

function parseArgs(argv: string[]) {
  let slug: string | null = null;
  let name: string | null = null;
  let description: string | null = null;
  const projects: string[] = [];
  let allProjects = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--slug') {
      slug = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (argument === '--name') {
      name = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (argument === '--description') {
      description = argv[index + 1] ?? null;
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
    slug,
    name,
    description,
    projects,
    allProjects,
  };
}
