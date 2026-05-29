# Checkpoints

## Current system state

- Runtime stack: Fastify + TypeScript + Prisma + PostgreSQL + Zod + Vitest.
- Session auth is stateful and cookie-based with an opaque `httpOnly` cookie
  backed by `Session.secretHash`.
- Public auth endpoints are available:
  `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`,
  `GET /auth/me`.
- Project bootstrap data is seeded for:
  `other-gpt` with roles `user`, `pro`, `admin`;
  `cost-console` with roles `user`, `admin`.
- Project memberships support multiple roles per membership through
  `ProjectMembershipRole`.
- Project-scoped authorization endpoints are available:
  `GET /projects/:slug/me`,
  `POST /projects/:slug/memberships`,
  `PUT /projects/:slug/memberships/:userId/roles`.

## Completed slices

- Service foundation with Fastify, TypeScript, env validation, logging,
  Prisma, health checks, linting, and test tooling.
- Basic auth with register, login, logout, and current-user session
  introspection.
- Identity schema for users, credentials, sessions, projects, project roles,
  memberships, and membership-role joins.
- Seed bootstrap for initial projects and project roles.
- Project-scoped access introspection and admin-only membership management.

## Current slice

- Slice: Project memberships + project-scoped authorization.
- Status: implemented.
- Scope delivered:
  `GET /projects/:slug/me` for access introspection,
  `POST /projects/:slug/memberships` for admin admission by email,
  `PUT /projects/:slug/memberships/:userId/roles` for full role-set
  replacement.
- Shared auth extraction completed through `src/shared/auth/session-auth.ts`
  so future modules can reuse authenticated-session guards without importing
  `auth.services`.

## Next slices

- Add project member listing for admins with pagination and filtering.
- Add membership lifecycle operations: revoke, suspend, reactivate.
- Decide whether project status (`DISABLED`) should actively gate access and
  admin operations at HTTP level.
- Introduce audit logging for project membership changes.
- Define admin UX or operational tooling beyond local bootstrap scripts.

## Closed decisions

- Authorization is project-scoped only. There is no global admin role.
- Membership admin operations require an `ACTIVE` membership with the
  project-local `admin` role.
- Role validation is always scoped by `(projectId, code)`, so shared role codes
  across projects do not collide.
- Membership creation identifies the target user by normalized email and never
  creates a user implicitly.
- Role updates replace the full set of membership roles in one operation.
- First-project-admin bootstrap is handled by a local script, not by a
  temporary HTTP endpoint.

## Operational notes

- Local seed for projects and roles:

  ```powershell
  npm run db:seed
  ```

- Bootstrap the first admin for all seeded projects:

  ```powershell
  npm run db:bootstrap-admin -- --email admin@example.com --all-projects
  ```

- Bootstrap the first admin for one specific project:

  ```powershell
  npm run db:bootstrap-admin -- --email admin@example.com --project other-gpt
  ```

- The bootstrap script expects the user to exist already. Create the user first
  through `POST /auth/register` or direct local DB setup before running it.
- The bootstrap script is idempotent for the selected projects. It ensures an
  `ACTIVE` membership and the `admin` role for the target user without creating
  duplicate assignments.

## Open questions

- Should future slices block access when `Project.status = DISABLED`, or is that
  status only descriptive for now?
- Should a future admin-management slice allow removing the last remaining admin
  of a project, or should that be prevented?
- Should membership metadata get a first-class contract soon, or remain opaque
  until an explicit use case appears?
