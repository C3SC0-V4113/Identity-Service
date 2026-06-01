# ADR 0009: Support Readmission of Revoked Memberships via Approval

- Date: 2026-05-31
- Status: Accepted
- Supersedes (in part): the "membership revocation is terminal" decision of ADR 0007

## Context

ADR 0007 made membership revocation terminal in the HTTP surface: a `REVOKED`
membership could not be reactivated or readmitted through the API, and login
never reactivates a `SUSPENDED` or `REVOKED` membership. The checkpoints carried
this as an open question: "should the service eventually support a first-class
readmission flow for revoked memberships, or keep revocation permanently
terminal?"

ADR 0008 introduces the administrative operational surface (service-principal
auth, common envelope, risk-based approval, and the `AdminActionAudit` /
`AdminApproval` records). That surface gives readmission a safe home: it can be a
deliberate, audited, approval-gated administrative action rather than an
unguarded state flip. This ADR resolves the open question by defining readmission
as exactly that.

## Decision Drivers

- Allow recovery from an erroneous or no-longer-applicable revocation without
  forcing the user to be recreated.
- Keep `REVOKED -> ACTIVE` a deliberate, attributable, reversible-on-record
  action rather than a casual reactivation.
- Avoid weakening the cookie surface, where login still must not resurrect
  `SUSPENDED` or `REVOKED` memberships.

## Decision

Readmission of a `REVOKED` membership is a first-class administrative operation,
`readmitProjectMembership`, exposed **only** through the ADR 0008 admin surface.

- It transitions a membership from `REVOKED` to `ACTIVE`. Roles are reset to the
  project default self-service role (`user`) unless an explicit role set is
  provided in the operation `payload`.
- It is classified `high_risk`, so it always creates an `AdminApproval` and
  applies no side effects until the action is confirmed through `decideApproval`
  (a deliberate two-step guard; the same operator may confirm). The membership
  state is revalidated before execution (a membership no longer `REVOKED` at
  decision time fails the operation).
- It records a new `ProjectMembershipAuditLog` action, `READMITTED`, with the
  `fromStatus`/`toStatus` and role transition, in addition to the
  `AdminActionAudit` milestones emitted by the admin surface.
- The cookie-based surface is unchanged: login still never reactivates a
  `SUSPENDED` or `REVOKED` membership, and there is no self-service readmission.

The "membership revocation is terminal in the HTTP surface" decision from
ADR 0007 is therefore superseded: revocation is reversible only through this
approval-gated administrative operation, never implicitly.

## Consequences

### Positive

- Operators can recover from mistaken or stale revocations with a full audit and
  a deliberate two-step confirmation.
- Readmission is attributable end to end via `operationId` and the `READMITTED`
  membership audit row.

### Negative

- A new high-risk operation and a new audit action to model and test.
- The "terminal revocation" mental model is replaced by "terminal unless an
  approved readmission says otherwise".

### Risks

- Readmission must respect the same invariants as other lifecycle operations
  (e.g. it does not bypass project-disabled gating, and it cannot be used to
  circumvent the last-active-admin protection on role assignment).

## Related Decisions

- ADR 0007 introduced terminal revocation, now superseded in part.
- ADR 0008 defines the admin surface, risk policy, and approval mechanics this
  operation relies on.
- `platform-ai-architecture` ADR 0008 lists `auth.revokeProjectAccess` and the
  approval model; readmission is the inverse recovery action within that model.

## References

- `prisma/schema.prisma` (`ProjectMembershipAuditAction`, `MembershipStatus`)
- `src/modules/project-memberships/project-memberships.services.ts`
