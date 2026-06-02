# Admin & MCP Integration Guide

How `mcp-server`, `openclaw-ops`, and operators integrate with the
machine-to-machine administrative surface of `identity-service`, plus the local
admin commands. For the end-user (cookie) surface see
[User App Integration Guide](./integration-user-apps.md).

Related decisions:
[ADR 0008](./adrs/0008-adopt-admin-operational-surface-with-service-principal-and-risk-approval.md),
[ADR 0009](./adrs/0009-support-readmission-of-revoked-memberships-via-approval.md).

## Mental model

- **`identity-service` is the authority.** It owns authorization, the risk
  policy, approvals, and the audit trail.
- **`mcp-server` is a thin facade.** It exposes the operations below as MCP tools
  (`auth.createUser`, `auth.banUser`, …), validates the MCP schema, injects the
  caller identity, and forwards to this HTTP surface. It must **not** write to the
  database or re-implement permission/approval logic.
- **`openclaw-ops` is the operator.** A single global operations bot drives the
  tools; the human behind it is propagated as `operatorUserId`.
- **This surface is bearer-authenticated, not cookie-authenticated.** It is
  entirely separate from the user surface.

## Authentication: service principals

The surface authenticates with a **service principal** bearer token, created by a
local bootstrap (token shown once; only its SHA-256 hash is stored):

```powershell
# Global principal (the openclaw-ops grant):
npm run db:bootstrap-service-principal -- --slug openclaw-ops --name "OpenClaw Ops" --all-projects
# Project-scoped principal:
npm run db:bootstrap-service-principal -- --slug mcp-server --name "MCP Server" --project other-gpt
```

Send it on every request:

```http
Authorization: Bearer <service-principal-token>
```

- **Global vs scoped.** A principal either has `allProjects` (global) or an
  explicit project allow-list. It authenticates globally and targets a project
  **per operation** via `targetProjectId`; there is no per-project re-login.
- **Out-of-scope target.** Reads against a forbidden project return
  `403 SERVICE_PRINCIPAL_PROJECT_FORBIDDEN`; mutations record a `denied` outcome.
- **Rotation / disable.** Re-running the bootstrap for the same `--slug` rotates
  the secret (invalidating the old token) and re-syncs the allow-list. A disabled
  principal gets `403 SERVICE_PRINCIPAL_DISABLED`; a missing/invalid token gets
  `401 SERVICE_PRINCIPAL_AUTH_REQUIRED`.

### `targetProjectId` is the project id, not the slug

The envelope identifies the project by its `id` (a cuid), not its slug. Resolve
the id once (e.g. via Prisma Studio or your own bootstrap) and cache it in the
`mcp-server` config per project.

## The common envelope

Every **mutating** operation takes the same request envelope:

```json
{
  "targetProjectId": "cmpow39iv0000pmig8x9rsm6r",
  "reason": "why this action is happening",
  "idempotencyKey": "unique-per-request-key",
  "ticketRef": "OPS-123", // optional
  "channel": "telegram", // where the request originated
  "operatorUserId": "operator-123", // the human operator (optional, recommended)
  "payload": { "...": "operation-specific" }
}
```

And returns the same response envelope (HTTP `200` for every outcome):

```json
{
  "status": "completed", // completed | pending_approval | denied | failed
  "operationId": "...",
  "approvalId": null, // set when status is pending_approval
  "auditEventId": "...",
  "message": "human-readable",
  "result": { "...": "operation-specific, or null" }
}
```

HTTP status is `200` for all four envelope outcomes. Non-`200` is reserved for
transport-level problems: `401`/`403` (auth), `404 PROJECT_NOT_FOUND`,
`403 PROJECT_DISABLED`, `400 VALIDATION_ERROR`, `409 ADMIN_IDEMPOTENCY_KEY_REUSED`.

### Idempotency

- `idempotencyKey` is unique per `(servicePrincipal, idempotencyKey)` and scoped
  to **one logical request** — use a fresh key per distinct call.
- Retrying a key replays the stored outcome for `completed` / `pending_approval` /
  `denied`. A `failed` outcome applied no side effect, so retrying the same key
  **re-executes** (reusing the same operation row, keeping the full audit
  history).
- Reusing a key for a **different** operation returns
  `409 ADMIN_IDEMPOTENCY_KEY_REUSED`.

### Correlation id

Send `X-Correlation-Id: <id>` to thread a trace across systems; it is stored on
the operation and recoverable from the audit trail.

## Risk and approval

Risk is classified centrally (`admin-operations.policy.ts`) and defaults to safe
(an unknown operation is treated as high-risk).

| Operation                                        | Risk            |
| ------------------------------------------------ | --------------- |
| `createUser`, `unbanUser`, `revokeProjectAccess` | low (direct)    |
| `revokeSession` (single, by `sessionId`)         | low (direct)    |
| `assignProjectRole` (non-admin roles)            | low (direct)    |
| `assignProjectRole` (grants `admin`)             | high (approval) |
| `revokeSession` (mass, by `userId`)              | high (approval) |
| `banUser`, `readmitProjectMembership`            | high (approval) |

High-risk operations do **not** apply side effects immediately. They return
`status: "pending_approval"` with an `approvalId`, and the action is applied only
after a second deliberate call to `decideApproval`.

- It is a **two-step confirmation guard, not a two-person rule.** The portfolio
  runs a single bot, so the same operator may confirm their own request; the value
  is the mandatory second deliberate step.
- Approvals **expire after 24h**; deciding an expired approval returns `denied`.
- State is revalidated before execution (e.g. readmitting a membership that is no
  longer `REVOKED` fails).

## Operation reference

All mutations are `POST` with the common envelope; reads are `GET` with query
params. Every call requires the bearer token.

### Create a user — `POST /admin/users`

- **Risk:** low (direct). **Payload:** `{ email, displayName?, password?, roleCodes? }`.
- Creates an ecosystem user and an `ACTIVE` membership in `targetProjectId`
  (roles default to `["user"]`). `result` contains the created user + membership.
- A duplicate email returns `status: "failed"` (`USER_ALREADY_EXISTS`).

### List project users — `GET /admin/users?targetProjectId=&status=&q=&limit=&cursor=`

- **Read.** Paginated membership list for the project (cursor-based). `status`
  filters by membership status; `q` matches email/displayName.

### Get a user's access status — `GET /admin/users/:userId/access?targetProjectId=`

- **Read.** Returns the user plus their membership status, roles, and `isAdmin`
  for the project.

### List pending approvals — `GET /admin/approvals?targetProjectId=&limit=&cursor=`

- **Read.** Pending approvals. For a scoped principal, omit `targetProjectId` to
  list across its allowed projects; a global principal sees all.

### Ban a user — `POST /admin/users/ban`

- **Risk:** high (approval). **Payload:** `{ userId }`. Globally bans the user
  (blocks login everywhere). Returns `pending_approval`.

### Unban a user — `POST /admin/users/unban`

- **Risk:** low (direct). **Payload:** `{ userId }`. Restores `ACTIVE` status.

### Assign project roles — `POST /admin/memberships/roles`

- **Risk:** low, unless `roleCodes` includes `admin` → high (approval).
  **Payload:** `{ userId, roleCodes }`. Replaces the membership's role set.
  Protected by the last-active-admin invariant.

### Revoke project access — `POST /admin/memberships/revoke`

- **Risk:** low (direct). **Payload:** `{ userId }`. Sets membership to `REVOKED`.
  Cannot remove the project's last active admin (`failed`).

### Readmit a revoked membership — `POST /admin/memberships/readmit`

- **Risk:** high (approval). **Payload:** `{ userId, roleCodes? }`. Transitions
  `REVOKED → ACTIVE` (roles reset to `user` unless provided). See ADR 0009.

### Revoke sessions — `POST /admin/sessions/revoke`

- **Payload:** exactly one of `{ sessionId }` (single, low/direct) or `{ userId }`
  (mass per-user, high/approval). Sending neither/both is `400 VALIDATION_ERROR`.

### Decide an approval — `POST /admin/approvals/:approvalId/decide`

- Resolves a pending high-risk operation. **This call does not use the envelope.**
  **Body:** `{ decision: "approve" | "reject", operatorUserId, decisionReason? }`.
- `approve` runs the deferred side effect and returns `completed`; `reject`
  returns `denied`. Deciding a non-pending approval returns the operation's
  already-resolved outcome (idempotent); an expired one returns `denied`.

### Example: high-risk flow

```bash
# 1) Request the ban -> pending_approval + approvalId
curl -X POST "$API/admin/users/ban" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"targetProjectId":"<id>","reason":"abuse","idempotencyKey":"ban-1","channel":"telegram","operatorUserId":"op-1","payload":{"userId":"<userId>"}}'

# 2) Confirm it -> completed, user BANNED
curl -X POST "$API/admin/approvals/<approvalId>/decide" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"decision":"approve","operatorUserId":"op-1"}'
```

## Visibility for project admins

Machine operations audit only to the admin trail, not to the membership audit. A
project admin (cookie + `admin` role) can read the machine operations targeting
their project, read-only:

```http
GET /projects/:slug/admin-operations?status=&operationName=&limit=&cursor=
```

It returns operation metadata, status, targets, `policyVersion`, and the approval
summary — but not the redacted request/result snapshots.

## Guidance for `mcp-server` implementers

- Map each tool 1:1 to an operation; do not add a generic "run any admin action"
  tool.
- Inject identity server-side: set `operatorUserId` from the real OpenClaw
  operator and `channel` from the source; never trust the model to supply them.
- Generate a fresh `idempotencyKey` per logical request and a `X-Correlation-Id`
  per trace.
- Surface the envelope `status` to the operator. On `pending_approval`, expose the
  `approvalId` and the `decide` tool. On `denied`/`failed`, show `message`.
- Treat `409 ADMIN_IDEMPOTENCY_KEY_REUSED` as a client bug (key reused across
  different requests).

## Admin commands (local)

These are local maintenance scripts, not HTTP endpoints (destructive/global
actions stay off the network).

| Command                                                                            | Purpose                                                        |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `npm run db:seed`                                                                  | Seed projects and roles (`other-gpt`, `cost-console`).         |
| `npm run db:bootstrap-admin -- --email <e> --all-projects`                         | Grant a user the project `admin` role (first-admin bootstrap). |
| `npm run db:bootstrap-admin -- --email <e> --project <slug>`                       | Same, for one project.                                         |
| `npm run db:bootstrap-service-principal -- --slug <s> --name <n> --all-projects`   | Create/rotate a global machine principal (prints token once).  |
| `npm run db:bootstrap-service-principal -- --slug <s> --name <n> --project <slug>` | Create/rotate a project-scoped principal.                      |
| `npm run db:prune-admin-operations -- --older-than-days 90 --dry-run`              | Preview audit-trail pruning (no deletes).                      |
| `npm run db:prune-admin-operations -- --older-than-days 90 --export <file>`        | Archive then prune terminal operations older than the window.  |

The prune command only removes terminal operations (`COMPLETED`/`DENIED`/`FAILED`)
older than the window — never `PENDING_APPROVAL` — cascading to their audit and
approval rows.
