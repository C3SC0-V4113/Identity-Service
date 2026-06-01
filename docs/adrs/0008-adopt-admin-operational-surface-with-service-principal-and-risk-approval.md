# ADR 0008: Adopt an Admin Operational Surface with Service-Principal Auth and Risk-Based Approval

- Date: 2026-05-31
- Status: Accepted

## Context

The current HTTP surface is project-scoped and cookie-based (ADR 0007). Every
administrative action is performed by a human project admin through an
authenticated browser session, and the only operational tooling beyond that is a
local bootstrap script (`npm run db:bootstrap-admin`). The checkpoints listed
"define admin UX or operational tooling beyond local bootstrap scripts" as an
undefined next slice.

The wider portfolio already defines what that slice should become. In
`platform-ai-architecture`, this service is `auth-service`, and ADR 0008 there
("Operate Auth Admin via MCP with Risk-Based Approval") plus
`docs/projects/auth-service.md` specify a machine-to-machine administrative
surface that `openclaw-ops` drives through `mcp-server`. `auth-service` must stay
the single point of authorization, approval, and audit; `mcp-server` is only an
operational facade and must never write to the database directly.

This ADR adopts that vision for `identity-service`, adapted to the service's
actual implementation, and defines the slice end to end. It is a direction
decision: the implementation lands in later incremental slices (see
Implementation Notes). It does not change the existing cookie-based
project-admin surface, which remains the human-facing path.

## Decision Drivers

- Provide administrative tooling beyond local scripts without turning the
  cookie surface into a machine integration point.
- Keep `identity-service` as the single authority for authorization, approval,
  and audit, with `mcp-server`/`openclaw-ops` as thin operational callers.
- Make every administrative mutation reconstructable from an append-only audit
  trail keyed by `operationId` and `correlationId`.
- Prevent duplicate side effects from channel/chat retries via idempotency.
- Separate request from approval for high-risk actions, with no self-approval.
- Reuse existing membership and session service logic rather than reimplementing
  it behind the new surface.

## Decision

Adopt a dedicated administrative surface, separate from the cookie-based
project-admin endpoints, with the following shape.

### Machine identity (service principal)

- A new `ServicePrincipal` represents an operational caller (e.g. the
  `mcp-server` integration acting on behalf of `openclaw-ops`). It carries a
  `slug`, `name`, optional `description`, a `status` (`ACTIVE` | `DISABLED`),
  and timestamps including `lastUsedAt`.
- The credential is a high-entropy secret. Only its `secretHash` (SHA256) is
  persisted, mirroring `Session.secretHash`; the plaintext token is shown once
  at creation and never stored.
- The admin surface authenticates **only** by service principal (bearer token),
  never by user cookie. The human operator behind the call is propagated
  separately as `operatorUserId`.

### Project scope of a service principal

The machine identity is **global and project-targeted per operation**, not
project-scoped like a user session. A single bearer token authenticates the whole
admin surface; there is **no per-project re-login**. The project a mutation acts on
is chosen per call via `targetProjectId` in the envelope. This matches
`openclaw-ops` being a global administrative surface and the envelope already
carrying `targetProjectId`.

To keep least privilege, each `ServicePrincipal` is constrained to the projects it
may target:

- A boolean `allProjects` flag grants the principal every project. It is the
  global-admin grant intended for the `openclaw-ops` principal and is set only
  deliberately.
- Otherwise the principal holds an explicit project allow-list, modeled as a
  `ServicePrincipalProjectScope` join (`servicePrincipalId`, `projectId`). A new
  principal grants no projects by default; access is explicit.
- Authorization rule: every operation's `targetProjectId` must be permitted by the
  principal (either `allProjects = true` or the project present in its scope set).
  A disallowed `targetProjectId` resolves the operation as `denied` and is audited;
  it never executes the side effect.

This deliberately differs from the cookie surface, where there is no global admin
role; the service principal is the explicit, audited, opt-in global/scoped machine
authority the portfolio asked for.

### Common envelope

- Mutating operations accept a common request envelope:
  `targetProjectId`, `reason`, `idempotencyKey`, `ticketRef?`, `channel`,
  `payload`.
- Mutating operations return a common response:
  `status`, `operationId`, `approvalId?`, `auditEventId`, `message`, `result`.
- Minimum `status` values: `completed`, `pending_approval`, `denied`, `failed`.
- `idempotencyKey` is unique per `(servicePrincipalId, idempotencyKey)` so a
  retried call returns the original outcome instead of re-applying side effects.

### Operation family

Discrete operations mapped 1:1 to the portfolio tool family:

- Reads (execute directly): `listProjectUsers`, `getUserAccessStatus`,
  `listPendingApprovals`.
- Mutations: `createUser`, `assignProjectRole`, `revokeProjectAccess`,
  `revokeSession`, `banUser`, `unbanUser`, `readmitProjectMembership`
  (see ADR 0009), and `decideApproval`.

Side effects are delegated to existing logic: project membership operations
reuse `src/modules/project-memberships/project-memberships.services.ts`
(create / roles / suspend / revoke), and session revocation reuses the admin
revocation path in `src/modules/auth/auth.services.ts`. The new surface adds the
envelope, idempotency, risk policy, approval, and audit around that logic.

### Risk-based approval

- Reads and low-risk mutations execute directly.
- High-risk mutations create a pending `AdminApproval` and apply **no** side
  effects until a separate decision. Minimum high-risk set in v1:
  `assignProjectRole` to an admin role, `revokeSession` with mass scope,
  `banUser` in any scope, `readmitProjectMembership`, and anything a policy marks
  `high_risk`. `identity-service` decides the final risk and may escalate even
  when the operation name is the same.
- `decideApproval` is performed by a second operator. The requester cannot
  self-approve (`approvedByUserId != requestedByUserId`). Approvals expire by
  default after `24h`, and the action is revalidated against current state
  before execution.

### Operation state

- `AdminOperation`: the single-row anchor per operation. It carries the
  `operationName`, the resolved `status` (`COMPLETED` | `PENDING_APPROVAL` |
  `DENIED` | `FAILED`), the calling `servicePrincipalId`, `operatorUserId`,
  `sourceChannel`, the targets (`targetProjectId`/`targetUserId`/
  `targetSessionId`), `reason`, `ticketRef`, `correlationId`, `policyVersion`,
  and `errorCode`. The `idempotencyKey` is unique here, per
  `(servicePrincipalId, idempotencyKey)`, so a retried call resolves to the
  original operation instead of re-applying side effects. The public
  `operationId` is this row's id.
- `AdminActionAudit`: append-only audit of admin events, each referencing an
  `AdminOperation`, with milestone `eventType` values `REQUESTED`,
  `PENDING_APPROVAL`, `APPROVED`, `REJECTED`, `COMPLETED`, `DENIED`, `FAILED`.
  Reconstructable by `operationId` and `correlationId`. Request/result snapshots
  are stored redacted of secrets, tokens, and credentials.
- `AdminApproval`: live approval state (0..1 per operation) for pending and
  resolved actions, with an expiration timestamp.

The append-only audit needs a stable single-row anchor to host the idempotency
uniqueness (audit rows are many-per-operation), which is why `AdminOperation`
exists alongside the two records named in `platform-ai-architecture` ADR 0008.

This trail is distinct from the existing `ProjectMembershipAuditLog`, which stays
focused on membership mutations from the cookie surface.

## Consequences

### Positive

- `openclaw-ops` can operate auth early via `mcp-server` without absorbing the
  canonical permission or approval rules.
- Sensitive actions gain real separation between request and approval.
- Idempotency removes duplicate effects from channel/chat retries.
- Every admin action is reconstructable from an immutable, redacted audit trail.
- The cookie-based project-admin surface is untouched.

### Negative

- Operational experience for high-risk actions carries more friction.
- The service must model risk policy in addition to permissions.
- New state appears: machine credentials and pending approvals with expiry.

### Risks

- A leaked service-principal token is a high-value credential; rotation and
  `DISABLED` status must be operationally easy.
- The risk policy must default to safe (treat unknown as high-risk) so an
  unclassified operation never silently executes a sensitive change.

## Implementation Notes

The slice is documented in full here and delivered incrementally:

1. **Schema + machine auth. (Delivered)** Added `ServicePrincipal` (with an
   `allProjects` flag), `ServicePrincipalProjectScope` (join: `servicePrincipalId`,
   `projectId`), `AdminOperation` (with the unique
   `(servicePrincipalId, idempotencyKey)` index), `AdminActionAudit`, and
   `AdminApproval` to `prisma/schema.prisma`, plus `READMITTED` on
   `ProjectMembershipAuditAction` (ADR 0009), in migration
   `20260601022202_add_machine_admin_operations_foundation`. (`UserStatus`
   already has `BANNED` + `bannedAt`; the `BANNED -> ACTIVE` unban path lands with
   the operation logic in step 3.) Added
   `src/shared/auth/service-principal-auth.ts` mirroring
   `src/shared/auth/session-auth.ts` (resolve principal by `secretHash`, require
   `status = ACTIVE`, touch `lastUsedAt`) with `servicePrincipalCanAccessProject`
   / `assertServicePrincipalProjectAccess` for the `targetProjectId` allow-list,
   and `bootstrapServicePrincipal`
   (`src/modules/identity/bootstrap/service-principal-bootstrap.ts` +
   `prisma/bootstrap-service-principal.ts`, script
   `npm run db:bootstrap-service-principal`) that creates/rotates a principal with
   `--all-projects` or `--project <slug>` grants and prints the token once.
2. **Envelope + audit + direct path. (Delivered)** Added
   `src/modules/admin-operations/` (`routes` / `services` / `repositories` /
   `schemas` / `guards`) mounted under `/admin/*`, authenticated only by service
   principal (bearer token). Implemented the common mutation envelope, idempotent
   replay keyed by `(servicePrincipalId, idempotencyKey)`, the append-only
   `AdminActionAudit`/`AdminOperation` trail, the `denied`/`failed`/`completed`
   outcomes, the read operations (`listProjectUsers`, `getUserAccessStatus`,
   `listPendingApprovals`), and the first direct low-risk mutation
   `auth.createUser`. Routes: `POST /admin/users`, `GET /admin/users`,
   `GET /admin/users/:userId/access`, `GET /admin/approvals`.
3. **Risk + approval.** Add the risk engine, `AdminApproval` lifecycle, and the
   remaining mutations: `assignProjectRole`, `revokeProjectAccess`,
   `revokeSession`, `banUser`/`unbanUser`, `decideApproval`, and
   `readmitProjectMembership`.

- The admin surface validates input with Zod, consistent with existing modules.
- List operations reuse the cursor-pagination shape from project memberships,
  audit logs, and admin session listing.
- The auth tools must not expose arbitrary queries or write directly to
  PostgreSQL outside the defined operations.
- Machine operations audit exclusively to `AdminActionAudit`/`AdminOperation`;
  they do not write `ProjectMembershipAuditLog`. So `createUser`'s project
  admission is visible in the admin trail (by `operationId`) but not in the
  cookie-surface membership audit. This keeps the two trails cleanly separate per
  the decision above; surfacing machine mutations to project admins, if needed,
  is a later concern.

## Related Decisions

- ADR 0002 defines centralized identity with project-local authorization.
- ADR 0004 / ADR 0005 define the membership audit log and its read API, which
  this surface complements rather than replaces.
- ADR 0007 defines the cookie-based project-scoped surface that this surface sits
  beside.
- ADR 0009 defines revoked-membership readmission as a high-risk operation within
  this surface.
- `platform-ai-architecture` ADR 0008 ("Operate Auth Admin via MCP with
  Risk-Based Approval") and `docs/projects/auth-service.md` are the source of this
  vision.

## References

- `prisma/schema.prisma`
- `src/shared/auth/session-auth.ts`
- `src/modules/auth/auth.services.ts`
- `src/modules/project-memberships/project-memberships.services.ts`
- `src/modules/identity/bootstrap/project-admin-bootstrap.ts`
