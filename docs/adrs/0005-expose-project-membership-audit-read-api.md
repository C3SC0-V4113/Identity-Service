# ADR 0005: Expose Project Membership Audit Read API

- Date: 2026-05-31
- Status: Accepted

## Context

ADR 0004 introduced an immutable `ProjectMembershipAuditLog` trail for successful
administrative membership mutations, but deliberately left it internal: no read
API was exposed. The audit data therefore could only be inspected through direct
database access.

The checkpoints tracked an open question on whether membership audit history
should get a first-class admin read API. Operators reviewing project access need
a way to answer who changed a membership, when, and what changed, without
querying the database by hand. The data already exists; this decision is about
exposing it safely.

## Decision Drivers

- Operators need self-service review of administrative membership activity.
- Access to audit history must be restricted to project administrators.
- The read surface should reuse existing authorization and pagination patterns.
- Exposing reads must not weaken the immutability guarantees of ADR 0004.

## Decision

We expose a project-scoped, admin-only read endpoint:
`GET /projects/:slug/audit-logs`.

It returns audit rows for the project, newest first, with cursor-based
pagination identical in shape to `GET /projects/:slug/memberships`. The endpoint
supports optional filters by `action`, `targetUserId`, and `membershipId`.

Authorization reuses the existing guards: the project must exist and be enabled,
and the caller must hold an `ACTIVE` membership with the project-local `admin`
role. This yields `PROJECT_NOT_FOUND`, `PROJECT_DISABLED`, and
`PROJECT_ADMIN_REQUIRED` for free, consistent with the rest of the membership
API.

The endpoint is read-only. It does not add a `reason` field, and it introduces
no write, update, or delete path over audit rows. Each item exposes the action,
actor, target, membership id, the `from/to` status and role-code diffs, and the
creation timestamp.

## Consequences

### Positive

- Operators can review administrative membership activity without DB access.
- Reuses established auth, pagination, and response-shaping patterns, keeping the
  API surface consistent and the change small.
- Preserves ADR 0004 immutability: reads do not mutate audit state.

### Negative

- Adds a new public endpoint and its associated maintenance and test surface.
- Unbounded history growth (noted in ADR 0004) now has a user-facing consumer,
  making a future retention/pruning policy more relevant.

### Risks

- Audit rows can expose member emails to any project admin; this is acceptable
  because membership management already exposes the same data to admins.

## Implementation Notes

- Query parameters are validated by `listProjectAuditLogsQuerySchema`
  (`limit` 1-50 default 20, `cursor`, optional `action`/`targetUserId`/
  `membershipId`).
- The repository `listAuditLogsByProject` applies a keyset cursor on
  `(createdAt, id)` with `orderBy [createdAt desc, id desc]`, matching the
  membership list. The base64url cursor helper is shared with the membership
  list service.
- The service `listProjectMembershipAuditLogs` fetches `limit + 1` rows to derive
  `hasMore` / `nextCursor`.
- No schema or migration change was required; the read uses the indices already
  defined in ADR 0004.

## Related Decisions

- ADR 0004 records the audit trail that this read API exposes.
- ADR 0003 defines the initial identity data model.

## References

- `src/modules/project-memberships/project-memberships.routes.ts`
- `src/modules/project-memberships/project-memberships.services.ts`
- `src/modules/project-memberships/project-memberships.repositories.ts`
- `src/modules/project-memberships/project-memberships.schemas.ts`
