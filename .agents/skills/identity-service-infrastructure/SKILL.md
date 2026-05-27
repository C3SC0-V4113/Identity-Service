---
name: identity-service-infrastructure
description: Configure and maintain the Identity Service backend foundation. Use when Codex changes TypeScript, Fastify plugins, Prisma, ESLint, Prettier, Husky, Vitest, environment variables, Docker, deployment, hosting, package scripts, or other infrastructure/tooling for E:\Repositorios\Identity-Service.
---

# Identity Service Infrastructure

## Overview

Use this skill to keep infrastructure and tooling changes consistent for `identity-service`. Keep these tasks separate from auth domain implementation unless the user explicitly asks to implement users, credentials, sessions, roles, project memberships, audit logs, OpenClaw admin operations, or MCP tools.

## Workflow

1. Read `AGENTS.md`, `package.json`, `tsconfig.json`, `eslint.config.js`, `prisma/schema.prisma`, and relevant files under `src/`.
2. If the change is structural, check `docs/adrs` and create or update an ADR using `architecture-decision-records`.
3. Make the smallest coherent infrastructure change.
4. Keep `src/app.ts` limited to Fastify setup: plugins, routes, error handling, and cross-cutting HTTP concerns.
5. Keep `src/server.ts` limited to process startup.
6. Validate environment variables with Zod in `src/config/env.ts`.
7. Use `fastify.inject` for HTTP route tests.
8. Run the relevant checks before finishing.

## Boundaries

- Do not create auth domain models during pure infrastructure tasks.
- Do not write direct database logic in route handlers.
- Do not add framework abstractions unless they remove real complexity.
- Do not bypass Zod env validation for new runtime config.
- Do not treat MCP or OpenClaw tools as part of the foundation phase unless requested.

## Expected Checks

Run the checks that match the change. For foundation changes, run all of them:

```powershell
npm run typecheck
npm run lint
npm run test
npm run build
```

## References

Read `references/project-foundation.md` when changing project structure, scripts, env conventions, validation workflow, or the Fastify foundation.
