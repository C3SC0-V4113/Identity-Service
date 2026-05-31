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
- Project membership audit logs persist structured diffs for successful
  administrative HTTP mutations.
- Project-scoped authorization endpoints are available:
  `GET /projects/:slug/me`,
  `GET /projects/:slug/memberships`,
  `POST /projects/:slug/memberships`,
  `POST /projects/:slug/memberships/:userId/suspend`,
  `POST /projects/:slug/memberships/:userId/reactivate`,
  `POST /projects/:slug/memberships/:userId/revoke`,
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
- Admin-only project member listing with pagination and filtering.
- Membership lifecycle operations and project-disable gating.
- Internal audit logging for project membership mutations.

## Current slice

- Slice: Project membership audit logging.
- Status: implemented.
- Scope delivered:
  immutable audit rows for successful `create`, `roles replace`, `suspend`,
  `reactivate`, and `revoke` membership mutations,
  structured before/after diffs for membership status and role codes,
  and transactional audit persistence coupled to the underlying membership
  mutation.
- Shared auth extraction completed through `src/shared/auth/session-auth.ts`
  so future modules can reuse authenticated-session guards without importing
  `auth.services`.

## Next slices

- Expose membership audit history through a project-admin read API when a
  concrete UX or operator flow is defined.
- Define admin UX or operational tooling beyond local bootstrap scripts.
- Decide whether revoked memberships should eventually support first-class
  readmission through HTTP or a future operational flow.

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
- Project-scoped endpoints are blocked with `403 PROJECT_DISABLED` when
  `Project.status = DISABLED`.
- The API must not allow a project to lose its last `ACTIVE` admin through
  lifecycle operations or role replacement.
- Membership revocation is terminal in the current HTTP surface. Revoked
  memberships are not reactivated or readmitted through the API yet.
- Membership audit logging persists only successful administrative HTTP
  mutations and does not yet expose a read API or `reason` field.

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

- Should membership metadata get a first-class contract soon, or remain opaque
  until an explicit use case appears?
- Should membership audit history get a first-class admin read API soon, or
  remain internal until a concrete operator flow appears?
- Should the service eventually support a first-class readmission flow for
  revoked memberships, or keep revocation permanently terminal?
