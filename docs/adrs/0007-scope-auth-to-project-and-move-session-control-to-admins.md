# ADR 0007: Scope Auth to Projects and Move Session Control to Project Admins

- Date: 2026-05-31
- Status: Accepted
- Supersedes: ADR 0006

## Context

The initial auth slice and ADR 0006 exposed a global auth surface
(`POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`)
plus self-service session management over all of a user's active sessions.

That shape no longer matches the product direction for the portfolio apps.
Authentication must now be initiated from a concrete project and stay scoped to
that project. A normal user signing into `other-gpt` must not gain visibility
into, or revocation control over, their sessions in `cost-console`. Project
administrators still need to inspect and revoke sessions for users within their
own project.

The service still keeps centralized identity and project-local authorization as
set by ADR 0002. The change is about HTTP contracts, session scope, and who can
operate on sessions.

## Decision Drivers

- Make login and registration explicit to the project where they occur.
- Keep user identity centralized while keeping access and operations
  project-scoped.
- Remove cross-ecosystem session visibility for normal users.
- Preserve project-local admin control over user sessions.
- Keep the migration compatible with existing data without resetting the
  database.

## Decision

Adopt project-scoped authentication routes:

- `POST /projects/:slug/auth/register/email-check`
- `POST /projects/:slug/auth/register`
- `POST /projects/:slug/auth/login`
- `POST /projects/:slug/auth/logout`
- `GET /projects/:slug/auth/me`

Registration becomes a two-step flow. The email-check endpoint answers whether
the email already exists in the shared identity store:

- if the email does not exist, the client continues to project registration
- if the email already exists, the client redirects the user to project login

`POST /projects/:slug/auth/register` creates only new ecosystem users. It also
creates an `ACTIVE` membership in the target project and assigns the project's
default self-service role, which is the role code `user`.

`POST /projects/:slug/auth/login` authenticates against the shared user
credential. If the user does not yet have a membership in the target project,
login auto-creates an `ACTIVE` membership with the project role code `user`.
If the membership exists but is `SUSPENDED` or `REVOKED`, login is rejected;
authentication does not reactivate membership state.

Sessions become project-scoped. Each new `Session` stores the `projectId` that
issued it, and a session from one project cannot authenticate requests for a
different project. Existing legacy sessions that have no project association are
revoked during migration with reason `LEGACY_GLOBAL_SESSION`.

Normal users no longer have a self-service "other sessions" API. The
`/auth/sessions` endpoints are removed. A user can only end their current
project session through `POST /projects/:slug/auth/logout`.

Project admins gain project-local session operations:

- `GET /projects/:slug/sessions`
- `POST /projects/:slug/sessions/:sessionId/revoke`

These endpoints require an authenticated session for the same project and an
`ACTIVE` membership with the project-local `admin` role. There is still no
global admin role.

## Consequences

### Positive

- Authentication matches the app where the user is acting.
- Normal users cannot inspect or revoke sessions from other projects.
- Project admins can handle operational session issues without cross-project
  authority.
- Centralized identity is preserved while session enforcement becomes
  project-specific.

### Negative

- Existing clients must migrate from `/auth/*` to `/projects/:slug/auth/*`.
- Session rows now carry project scope, which adds migration and test surface.
- Legacy global sessions are invalidated and users must sign in again.

### Risks

- Any client that still assumes a global cookie usable across projects will fail
  until updated.
- The default self-service role code `user` is now a required project
  convention; missing seed data becomes a runtime configuration error.

## Implementation Notes

- `Session.projectId` is nullable in the schema only to preserve historical
  legacy rows; all newly issued sessions must set it.
- Project-scoped auth uses the shared session hash/cookie mechanism, but request
  auth now validates both the session state and the expected `projectId`.
- Admin session listing uses the same cursor-pagination shape as project
  memberships and audit logs.
- The auth response becomes project-local: it returns the authenticated user,
  the current project, and the membership/roles for that project only.

## Related Decisions

- ADR 0002 defines centralized identity with project-local authorization.
- ADR 0005 defines the admin read-API conventions reused for project session
  listing.
- ADR 0006 is superseded because session management is no longer self-service.

## References

- `prisma/schema.prisma`
- `src/shared/auth/session-auth.ts`
- `src/modules/auth/auth.routes.ts`
- `src/modules/auth/auth.services.ts`
- `src/modules/auth/auth.repositories.ts`
- `src/modules/project-memberships/project-memberships.routes.ts`
