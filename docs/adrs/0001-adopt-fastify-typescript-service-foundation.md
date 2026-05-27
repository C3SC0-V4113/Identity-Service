# ADR 0001: Adopt Fastify TypeScript Service Foundation

- Date: 2026-05-26
- Status: Accepted

## Context

`identity-service` is the implementation repo for the portfolio identity and access backend. It needs a small but reliable Node foundation before implementing users, credentials, sessions, project roles, audit logs, OpenClaw administration, or MCP tools.

The project should be approachable for learning Fastify while still providing enough guardrails to detect type, validation, linting, formatting, and test failures early.

## Decision Drivers

- Keep the service understandable for a first Fastify backend.
- Preserve a clean separation between HTTP wiring and domain rules.
- Use tooling that gives warnings or failures when code drifts from expected quality.
- Prepare for PostgreSQL without modeling auth domain tables yet.
- Keep OpenClaw and MCP as evolutionary integrations, not part of the first foundation step.

## Decision

Use the following service foundation:

- `Fastify` for HTTP.
- `TypeScript` in strict mode.
- `Zod` for runtime validation, starting with environment variables.
- `PostgreSQL` as the target database.
- `Prisma` for database access and migrations.
- `Pino` for structured logging through Fastify.
- `Vitest` for tests, using `fastify.inject` for HTTP integration tests.
- `ESLint` flat config, `Prettier`, `Husky`, and `lint-staged` as quality tooling.

Use a modular structure under `src/modules`. Each module may introduce `routes`, `schemas`, `services` or `use-cases`, and `repositories` when needed. The foundation only creates a `health` module.

## Consequences

### Positive

- The project starts with explicit checks for types, linting, tests, and builds.
- Fastify wiring stays separate from future identity domain rules.
- Prisma and PostgreSQL are ready without prematurely designing auth tables.
- Future modules can grow consistently without forcing a heavy framework.

### Negative

- More setup than a minimal Express-style server.
- Prisma, ESLint flat config, and Fastify plugins add concepts to learn early.
- The foundation does not yet prove the auth domain model.

## Implementation Notes

- `src/server.ts` is the process entrypoint.
- `src/app.ts` builds and configures the Fastify app.
- `src/config/env.ts` validates environment variables with Zod.
- `GET /health` is the first route and should be tested with `fastify.inject`.
- OpenClaw and MCP are expected later, after the API and database foundation are stable.

## Related Decisions

- Portfolio ADR 0002 adopts a multi-repo portfolio.
- Portfolio ADR 0003 centralizes authentication with project isolation.
- Portfolio ADR 0006 defines the runtime, quality tooling, hosting direction, and OpenClaw admin posture for this service.
