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
- Project membership audit history is exposed through an admin-only read API.
- Project-scoped authorization endpoints are available:
  `GET /projects/:slug/me`,
  `GET /projects/:slug/memberships`,
  `GET /projects/:slug/audit-logs`,
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
- Admin-only project membership audit history read API with filtering and
  pagination.

## Current slice

- Slice: Project membership audit history read API.
- Status: implemented.
- Scope delivered:
  `GET /projects/:slug/audit-logs`, admin-only and project-scoped, returning
  audit rows newest-first with cursor-based pagination,
  optional filters by `action`, `targetUserId`, and `membershipId`,
  response items exposing the action, actor, target, membership id, the
  before/after status and role-code diffs, and the creation timestamp.
- Read-only over the existing `ProjectMembershipAuditLog` data: no schema or
  migration change, no `reason` field, and no audit write/update/delete surface.
- Reuses the existing project/admin guards and the membership-list cursor
  helpers, keeping authorization and pagination consistent across the module.

## Next slices

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
  mutations and does not yet capture a `reason` field.
- Membership audit history is exposed read-only to project admins through
  `GET /projects/:slug/audit-logs`. The audit trail remains immutable: there is
  no write, update, or delete surface over audit rows.

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
- Should the audit read API eventually gain a `reason` field and/or an export
  or retention/pruning policy as history grows?
- Should the service eventually support a first-class readmission flow for
  revoked memberships, or keep revocation permanently terminal?
