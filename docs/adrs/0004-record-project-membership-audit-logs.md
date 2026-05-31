# ADR 0004: Record Project Membership Audit Logs

- Date: 2026-05-30
- Status: Accepted

## Context

`identity-service` already exposes project-scoped membership administration for
creation, role replacement, suspension, reactivation, and revocation.

Those mutations now change authorization state for real users inside real
projects. The service needs an internal audit trail for those administrative
changes without redesigning the public HTTP surface yet.

The current product direction also clarifies that:

- project-scoped membership administration is the only current source of these
  mutations;
- project membership metadata remains opaque;
- revoked memberships remain terminal in the HTTP surface; and
- there is no approved admin history API yet.

## Decision Drivers

- Persist a reliable audit trail for successful administrative membership
  mutations.
- Keep HTTP handlers thin and preserve the existing API contracts.
- Keep the first audit slice additive and safe for existing PostgreSQL data.
- Prefer a structured diff over an opaque JSON blob for the currently known
  domain changes.
- Ensure audit rows are committed atomically with the membership mutation.

## Decision

Add an internal `ProjectMembershipAuditLog` relational model and persist one
immutable audit row for each successful HTTP membership mutation in the
`project-memberships` module.

The slice records only these actions:

- `CREATED`
- `ROLES_REPLACED`
- `SUSPENDED`
- `REACTIVATED`
- `REVOKED`

Each audit row stores:

- the project;
- the membership;
- the actor user;
- the target user;
- `fromStatus` and `toStatus`;
- `fromRoleCodes` and `toRoleCodes`; and
- the creation timestamp.

The service does not expose a read API for these audit rows in this slice and
does not add a human `reason` field to the existing HTTP endpoints.

Audit writes must occur inside the same database transaction as the membership
mutation so the audit trail and the domain write succeed or fail together.

## Consequences

### Positive

- Administrative membership changes now leave a durable server-side trace.
- The audit payload stays explicit and queryable without parsing JSON.
- Existing clients do not need to change because the HTTP surface is unchanged.
- The Prisma migration remains additive and preserves current local data.

### Negative

- There is still no product API for admins to inspect the audit history.
- The slice captures only status and role diffs, not free-form operator intent.
- Bootstrap scripts and non-HTTP operational flows remain outside this audit
  trail for now.

## Implementation Notes

- Use a real Prisma migration and do not reset the database.
- Keep the audit logic in module services and repositories, not in route
  handlers.
- Record only successful HTTP mutations. Failed validations and rejected
  transitions do not produce audit rows.
- Update the database model and checkpoint documentation when the slice lands.

## Related Decisions

- ADR 0001 adopts the Fastify TypeScript service foundation.
- ADR 0002 adopts centralized, session-based portfolio identity.
- ADR 0003 defines the initial identity and authorization data model.
