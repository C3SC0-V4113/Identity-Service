# ADR 0003: Define Initial Identity Data Model

- Date: 2026-05-27
- Status: Accepted

## Context

`identity-service` already has its technical foundation and the product
direction for centralized, session-based identity. The next step is to make the
first auth-adjacent persistence slice concrete without exposing HTTP endpoints
yet.

The service needs a database model that can support:

- centralized user identity;
- local credentials for the initial authentication strategy;
- revocable and renewable server-side sessions;
- multiple connected projects with isolated authorization models; and
- future growth toward richer authorization and administrative tooling.

The product direction also clarifies that role names may look similar across
projects while still representing different authorization meanings. For
example, `admin` in `other-gpt` and `admin` in `cost-console` must not be
treated as a single global role.

## Decision Drivers

- Keep identity centralized while preserving project isolation for authorization.
- Model revocable session state explicitly in the database.
- Support project-specific roles without introducing a global role catalog.
- Keep the first slice small enough to unblock later endpoint work.
- Document the model clearly in Markdown so it remains easy to inspect and
  evolve.

## Decision

Adopt the following initial relational model:

- `User` stores centralized identities.
- `LocalCredential` stores the initial `email + password` local credential.
- `Session` stores revocable and renewable server-managed sessions.
- `Project` stores connected applications that delegate identity to this
  service.
- `ProjectRole` stores the roles available within a single project.
- `ProjectMembership` links a user to a project.
- `ProjectMembershipRole` links a membership to one or more roles within that
  project.

The model must enforce:

- a unique normalized email per user;
- a unique project slug;
- a single local credential per user;
- unique role codes only within a project, not globally;
- a single membership per user and project; and
- a unique role assignment per membership.

The initial bootstrap data includes:

- project `other-gpt` with roles `user`, `pro`, and `admin`;
- project `cost-console` with roles `user` and `admin`.

Permissions are documented for those roles, but permissions are not yet stored
as relational entities in this slice.

## Consequences

### Positive

- The first auth schema becomes concrete without prematurely exposing routes.
- Role isolation is preserved at the project boundary.
- Future endpoint work can build on stable persistence and constraints.
- The schema leaves room for multiple roles per membership where a project
  needs them.

### Negative

- Permissions remain documentation-only for now, so authorization enforcement
  logic cannot yet be driven from a relational permission catalog.
- Session state introduces operational lifecycle concerns such as expiry,
  revocation, and cleanup.
- External providers, password recovery, and audit trails remain outside this
  first slice.

## Implementation Notes

- Keep the HTTP surface unchanged in this slice.
- Generate a real Prisma migration for the new schema.
- Add a seed flow for the initial project and role catalog.
- Document the database model in Markdown with a Mermaid ER diagram.
- Do not add `Permission` or `RolePermission` tables yet.

## Related Decisions

- ADR 0001 adopts the Fastify TypeScript service foundation.
- ADR 0002 adopts centralized, session-based portfolio identity.
