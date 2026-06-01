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

### Admin operational surface (MCP-facing)

- Status: defined (ADR 0008); foundation, direct-path surface, and the approval
  lifecycle implemented; remaining membership/session mutations pending.
  Delivered: `ServicePrincipal` + project allow-list,
  `AdminOperation`/`AdminActionAudit`/`AdminApproval` schema, bearer-token machine
  auth, the service-principal bootstrap script, the `/admin/*` surface with the
  common envelope, idempotent replay, append-only audit, reads (`listProjectUsers`,
  `getUserAccessStatus`, `listPendingApprovals`), the low-risk mutations
  `auth.createUser` and `auth.unbanUser`, and the approval lifecycle:
  `auth.banUser` (high-risk → `pending_approval`) and `decideApproval`
  (approve/reject as a two-step confirmation guard — the same operator may
  confirm — 24h expiry, deferred execution on approval). Pending:
  `assignProjectRole`, `revokeProjectAccess`,
  `revokeSession`, and `readmitProjectMembership` (need the project-membership
  invariants and a stored execution payload for approval-time replay).
- Scope: a machine-to-machine administrative surface, separate from the
  cookie-based project-admin endpoints, that `mcp-server`/`openclaw-ops` consume.
  `identity-service` stays the single authority for authorization, approval, and
  audit; callers never write to the database directly.
- Machine identity: a new `ServicePrincipal` authenticates the surface by bearer
  token (only the `secretHash` is persisted, like `Session.secretHash`); the
  human operator is propagated separately as `operatorUserId`. The token is
  global and project-targeted per operation (no per-project re-login): the
  principal either has `allProjects = true` (the `openclaw-ops` global grant) or
  an explicit `ServicePrincipalProjectScope` allow-list, and a `targetProjectId`
  outside its scope resolves the operation as `denied`.
- Contract: mutations use a common envelope
  (`targetProjectId`, `reason`, `idempotencyKey`, `ticketRef?`, `channel`,
  `payload`) and a common response
  (`status` ∈ `completed|pending_approval|denied|failed`, `operationId`,
  `approvalId?`, `auditEventId`, `message`, `result`). `idempotencyKey` is unique
  per `(servicePrincipalId, idempotencyKey)`.
- Operation family: reads `listProjectUsers`, `getUserAccessStatus`,
  `listPendingApprovals`; mutations `createUser`, `assignProjectRole`,
  `revokeProjectAccess`, `revokeSession`, `banUser`, `unbanUser`,
  `readmitProjectMembership`, `decideApproval`. Side effects reuse existing
  membership services and the admin session-revocation path.
- State: append-only `AdminActionAudit` (milestones `REQUESTED`,
  `PENDING_APPROVAL`, `APPROVED`, `REJECTED`, `COMPLETED`, `DENIED`, `FAILED`,
  reconstructable by `operationId`/`correlationId`, snapshots redacted) plus live
  `AdminApproval` (default `24h` expiry).
- Risk policy: reads and low-risk mutations execute directly; high-risk
  (`assignProjectRole` to admin, mass `revokeSession`, `banUser`, `readmit`)
  create a pending approval that a deliberate second `decideApproval` call
  confirms or rejects (a two-step guard, not a two-person rule — the same
  operator may confirm); state is revalidated before execution.

### Revoked membership readmission

- Status: defined (ADR 0009), not implemented.
- Scope: a high-risk `readmitProjectMembership` operation inside the admin
  surface that transitions a membership `REVOKED -> ACTIVE` (roles reset to the
  default `user` role unless an explicit set is supplied), gated by approval and
  recorded with a new `READMITTED` membership audit action. The cookie surface is
  unchanged: login still never reactivates `SUSPENDED`/`REVOKED` memberships.

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
- Membership revocation is terminal in the cookie-based HTTP surface and through
  login: neither path reactivates or readmits a `REVOKED` membership. Readmission
  is allowed only as an approval-gated administrative operation (ADR 0009), which
  supersedes the previous "revocation is permanently terminal" stance.
- Membership audit logging persists only successful administrative HTTP
  mutations and does not yet capture a `reason` field. The richer admin trail
  with `reason`/`operationId`/`correlationId` lives in the planned
  `AdminActionAudit`, not in `ProjectMembershipAuditLog`.
- Membership audit history is exposed read-only to project admins through
  `GET /projects/:slug/audit-logs`. The audit trail remains immutable: there is
  no write, update, or delete surface over audit rows.
- Administrative tooling beyond local bootstrap scripts is delivered as a
  service-principal-authenticated machine surface (ADR 0008), not over the cookie
  surface. `mcp-server`/`openclaw-ops` are operational callers and never write to
  the database directly.
- A service principal authenticates globally and selects the project per
  operation via `targetProjectId`; it never re-logs in per project. Project reach
  is least-privilege: `allProjects` (the global `openclaw-ops` grant) or an
  explicit project allow-list, enforced before any side effect.
- Every admin-surface mutation carries `reason` + `idempotencyKey` and emits an
  append-only audit event reconstructable by `operationId`/`correlationId`;
  request/result snapshots are stored redacted of secrets.
- High-risk admin operations (`assignProjectRole` to admin, mass `revokeSession`,
  `banUser`, `readmit`) require a deliberate confirmation step via `decideApproval`
  before they take effect. This is a two-step guard, not a two-person rule: the
  portfolio runs a single `openclaw-ops` bot, so the same operator may confirm
  their own request. Approvals expire by default after `24h`, and the action is
  revalidated against current state before execution.
- Admin-surface idempotency: `idempotencyKey` is scoped to one logical request,
  unique per `(servicePrincipalId, idempotencyKey)`. Retrying replays the stored
  outcome for `COMPLETED`/`PENDING_APPROVAL`/`DENIED`, but a `FAILED` outcome
  (no side effect applied) re-executes on retry, reusing the same operation row
  and appending to its audit history. Reusing the key for a _different_ operation
  is rejected with `409 ADMIN_IDEMPOTENCY_KEY_REUSED`. Callers use a unique key
  per distinct request.

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

- Bootstrap a global (`openclaw-ops`) service principal for the admin surface:

  ```powershell
  npm run db:bootstrap-service-principal -- --slug openclaw-ops --name "OpenClaw Ops" --all-projects
  ```

- Bootstrap a project-scoped service principal:

  ```powershell
  npm run db:bootstrap-service-principal -- --slug mcp-server --name "MCP Server" --project other-gpt
  ```

- The service-principal bootstrap prints the bearer token once; only its hash is
  stored. Re-running for the same `--slug` rotates the secret and re-syncs the
  project allow-list, which invalidates the previous token.

## Open questions

- Should membership metadata get a first-class contract soon, or remain opaque
  until an explicit use case appears?
- Should the membership audit read API eventually gain an export or
  retention/pruning policy as history grows? (The `reason` and richer
  attribution gap is now answered by the planned `AdminActionAudit`, and
  first-class readmission is decided in ADR 0009.)
- Should project admins eventually gain visibility into session history
  (revoked/expired rows only) or bulk revocation flows, or remain limited to
  direct per-session actions until a concrete use case appears?
