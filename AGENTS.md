# AGENTS.md

## Project nature

`identity-service` is the implementation repo for the portfolio identity and access backend. Unlike `platform-ai-architecture`, this repo contains product code.

## Technical baseline

- Runtime: `Fastify`
- Language: `TypeScript` with strict checks
- Validation: `Zod`
- Database: `PostgreSQL`
- ORM and migrations: `Prisma`
- Logging: `Pino`
- Tests: `Vitest`

## Architecture rules

- Keep a clean, lightweight modular architecture.
- Keep HTTP handlers thin: parse request, call application logic, return response.
- Do not put domain rules directly in route handlers.
- Prefer module-local `routes`, `schemas`, `services` or `use-cases`, and `repositories` when the module needs them.
- Keep `src/app.ts` focused on Fastify instance construction, plugins, routes, and error handling.
- Keep `src/server.ts` as the process entrypoint only.
- Validate environment variables with Zod before starting the server.

## Documentation and decisions

- Structural decisions live in `docs/adrs`.
- Use the local `architecture-decision-records` skill when creating, updating, superseding, or reviewing ADRs.
- Use the local `identity-service-infrastructure` skill for changes to TypeScript, Fastify plugins, Prisma, ESLint, Prettier, Husky, Vitest, env, Docker, deployment, hosting, or npm scripts.

## Current scope

- The foundation phase may configure tooling, project structure, health checks, Prisma setup, and documentation.
- Do not implement auth domain features until explicitly requested: users, credentials, sessions, roles, project memberships, audit logs, OpenClaw admin tools, or MCP tools.

## Verification

Before considering implementation work complete, run the relevant checks:

- `npm run typecheck`
- `npm run lint`
- `npm run test`
- `npm run build`
