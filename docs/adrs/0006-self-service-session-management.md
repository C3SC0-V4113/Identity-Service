# ADR 0006: Self-Service Session Management

- Date: 2026-05-31
- Status: Superseded by ADR 0007

## Context

ADR 0002 commits `identity-service` to stateful, revocable, renewable sessions
and names "revoking or managing sessions" as a first-class concern. Until now the
auth surface only exposed `POST /auth/register`, `POST /auth/login`,
`POST /auth/logout`, and `GET /auth/me`. A user authenticated from several
devices had no way to see their active sessions or revoke a lost or compromised
one short of changing a password (a flow that does not yet exist).

The `Session` model already persists everything needed for this capability
(`status`, `createdAt`, `expiresAt`, `lastSeenAt`, `revokedAt`, `revokedReason`,
`ipAddress`, `userAgent`), so the gap was purely in the HTTP surface, not in the
data model.

## Decision Drivers

- Deliver session visibility and revocation promised by ADR 0002.
- Keep the change additive and safe: no schema or migration change.
- Respect the closed decision that there is no global admin role.
- Reuse existing authentication guards and house conventions.

## Decision

Expose a self-service session-management surface scoped to the authenticated
user:

- `GET /auth/sessions` lists the caller's own active, non-expired sessions,
  flagging the current one, and exposing `id`, `current`, `status`, `createdAt`,
  `lastSeenAt`, `expiresAt`, `ipAddress`, and `userAgent`.
- `POST /auth/sessions/:sessionId/revoke` revokes one of the caller's own
  sessions by id, returning `204`. Revoking an unknown or foreign session
  returns `404 SESSION_NOT_FOUND` without leaking existence or ownership.
- `POST /auth/sessions/revoke-others` revokes every other active session for the
  caller while keeping the current session alive, returning `{ revokedCount }`.

Scope is strictly self-service: a user can only see and revoke their own
sessions. Revocation is restricted to `ACTIVE` sessions, which transition to
`REVOKED` with `revokedAt` set and `revokedReason` of `USER_REVOKED` (single) or
`USER_REVOKED_OTHERS` (bulk). The existing logout path keeps `USER_LOGOUT`.

## Consequences

### Positive

- Users gain device visibility and can revoke suspicious sessions immediately.
- Fulfills the session-management direction set in ADR 0002.
- No schema or migration change; reuses the shared `requireAuthenticatedSession`
  guard and the established thin-handler and Zod-response conventions.

### Negative

- The list returns only active sessions, so historical (revoked/expired)
  sessions are not auditable through this surface yet.
- Self-service scope does not cover operator needs such as revoking another
  user's sessions.

### Risks

- Exposing `ipAddress`/`userAgent` reveals device metadata to the session owner
  only, which is the standard "your devices" pattern and acceptable.

## Implementation Notes

- Query/response shapes live in `auth.schemas.ts`
  (`sessionSummarySchema`, `sessionListResponseSchema`,
  `revokeOthersResponseSchema`, `sessionIdParamsSchema`).
- Repository helpers `listActiveSessionsByUserId`,
  `revokeActiveSessionByIdForUser`, and `revokeOtherActiveSessionsForUser` keep
  data access out of handlers; the id/bulk revokes use `updateMany` filtered by
  `userId` and `status: 'ACTIVE'` so cross-user access cannot occur.
- The current session id comes from `requireAuthenticatedSession`
  (`src/shared/auth/session-auth.ts`), used to flag `current` and to exclude the
  in-flight session from `revoke-others`.
- Revoke actions use `POST .../revoke` to match the membership lifecycle house
  style rather than `DELETE`.

## Related Decisions

- ADR 0002 sets the session-based identity direction and names session
  management as first-class.
- ADR 0005 establishes the read-API and pagination conventions reused here.

## References

- `src/modules/auth/auth.routes.ts`
- `src/modules/auth/auth.services.ts`
- `src/modules/auth/auth.repositories.ts`
- `src/modules/auth/auth.schemas.ts`
