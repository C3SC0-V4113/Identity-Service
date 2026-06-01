# Checkpoints

## Current system state

- Runtime stack: Fastify + TypeScript + Prisma + PostgreSQL + Zod + Vitest.
- Session auth is stateful, cookie-based, and project-scoped through
  `Session.projectId`.
- Public auth endpoints are available under `/projects/:slug/auth/*`:
  `POST /register/email-check`, `POST /register`, `POST /login`,
  `POST /logout`, `GET /me`, `GET /session`.
- Registration is project-scoped and two-step:
  email check first, then account creation only for new ecosystem users.
- Login auto-creates a base `ACTIVE` membership with the project role code
  `user` when an existing ecosystem user signs into a project for the first
  time.
- `GET /projects/:slug/auth/session` is the dedicated middleware-safe session
  validator. It returns `204` when the current project session is valid and
  `401` when it is no longer usable.
- Normal users cannot list or revoke their other sessions.
- Project admins can list and revoke sessions inside their own project through
  `GET /projects/:slug/sessions` and
  `POST /projects/:slug/sessions/:sessionId/revoke`.
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
- Identity schema for users, credentials, project-scoped sessions, projects,
  project roles, memberships, and membership-role joins.
- Seed bootstrap for initial projects and project roles.
- Project-scoped auth with register email check, register, login, logout, and
  current-user introspection plus lightweight current-session validation.
- Project-scoped access introspection and admin-only membership management.
- Admin-only project member listing with pagination and filtering.
- Membership lifecycle operations and project-disable gating.
- Internal audit logging for project membership mutations.
- Admin-only project membership audit history read API with filtering and
  pagination.
- Admin-only project session listing and revocation.

## Current slice

- Slice: project-scoped auth and session control.
- Status: implemented.
- Scope delivered:
  project-scoped `/projects/:slug/auth/*` endpoints, project-bound session
  validation, two-step registration, auto-admission to the base `user` role on
  first successful login to a project, dedicated
  `GET /projects/:slug/auth/session` validation for client middleware, and
  admin-only project session management.
- Migration note:
  legacy global sessions are revoked during schema migration with reason
  `LEGACY_GLOBAL_SESSION`.

## Next slices

- Define admin UX or operational tooling beyond local bootstrap scripts.
- Decide whether revoked memberships should eventually support first-class
  readmission through HTTP or a future operational flow.

## Closed decisions

- Authorization is project-scoped only. There is no global admin role.
- Sessions are issued and validated per project; a session from one project does
  not authenticate another project.
- `GET /projects/:slug/auth/session` is the canonical client-side session check;
  `GET /projects/:slug/auth/me` remains the profile endpoint.
- Registration is two-step and project-scoped. Existing ecosystem emails are
  redirected to login rather than re-registered.
- The default self-service role is the project role code `user`.
- Successful login may auto-create a missing membership in the current project,
  but it never reactivates `SUSPENDED` or `REVOKED` memberships.
- Normal users can only end their current project session through logout.
- Project admins can list and revoke sessions only inside their own project.
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
  memberships are not reactivated or readmitted through the API.
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
  through `POST /projects/:slug/auth/register` or direct local DB setup before
  running it.
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
- Should project admins eventually gain visibility into session history
  (revoked/expired rows only) or bulk revocation flows, or remain limited to
  direct per-session actions until a concrete use case appears?
