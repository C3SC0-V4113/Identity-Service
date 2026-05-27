---
name: identity-service-min-evaluation
description: Run the minimum local quality checks required for this repository before declaring implementation work complete. Use when wrapping up changes in identity-service, validating readiness, running final verification, or deciding which local checks are required for code, infrastructure, Prisma, env, Docker, script, or documentation changes.
---

# Identity Service Minimum Evaluation

Use this skill before declaring implementation work complete in `identity-service`.

This skill complements `AGENTS.md`. It does not replace repository-specific architecture, scope, or implementation rules.

## Required checks

Run all of these commands when the change touches application code, shared code, Prisma, environment validation, Docker or infrastructure files, package scripts, or repo tooling:

1. `npm run typecheck`
2. `npm run lint`
3. `npm run test`
4. `npm run build`

## Conditional scope

- Run the full check set for changes in `src/`, `prisma/`, `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, `.env.example`, `docker-compose.yml`, `.husky/`, or shared project tooling.
- If the change is docs-only, do not invent unsupported commands. Skip runtime checks and report that code verification was not required for the changed scope and that runtime behavior remains unverified.
- If a task is blocked and a required check cannot run, report the blocker instead of claiming completion.

## Failure reporting

If a required check fails or cannot be executed, report:

- exact command
- exact error or failure output
- remaining unverified scope

## Completion policy

Only report completion when every required check for the touched scope passes, or when blockers and unverified scope are clearly documented.
