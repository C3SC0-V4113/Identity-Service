# ADR 0002: Adopt Session-Based Portfolio Identity

- Date: 2026-05-27
- Status: Accepted

## Context

`identity-service` is intended to evolve from a technical foundation into the
central identity and access backend for multiple portfolio projects.

The product direction needs to be explicit before implementing auth domain
features. In particular, the service must clarify whether it is centered on
stateless token authentication or on server-managed sessions, how identities
relate to multiple projects, and how future external administration should fit
into the platform.

## Decision Drivers

- Keep authentication revocable and operationally manageable.
- Support session continuity without locking the design to a specific token or
  cookie shape yet.
- Centralize identity while allowing each portfolio project to define its own
  access rules and roles.
- Preserve room for future external administrative tooling without forcing MCP
  implementation into the current foundation phase.

## Decision

Adopt the following product direction for `identity-service`:

- The service is the central identity backend for multiple portfolio projects.
- Authentication is primarily stateful and session-based.
- Sessions are expected to be revocable and renewable over time.
- Stateless JWT authentication is not the intended primary product model for
  user authentication.
- User identity is centralized in this service, while authorization remains
  project-specific.
- Each project may define its own roles and associated project-specific
  information for the identities it admits.
- MCP-driven administrative capabilities are a near-term roadmap for external
  operations such as creating users, deleting users, banning or unbanning
  users, changing roles, and revoking or managing sessions.

This ADR sets the architectural direction only. It does not define cookie
formats, TTLs, token wire shapes, database schema details, or the MCP protocol
surface.

## Consequences

### Positive

- The service direction is explicit before auth features are implemented.
- Session revocation and lifecycle management become first-class concerns.
- Centralized identity can be reused across multiple portfolio projects without
  forcing shared authorization models.
- Future MCP administration has a documented place in the architecture.

### Negative

- Session-based authentication introduces server-side state that must be stored
  and managed.
- Some integrations that expect purely stateless auth may need adapters or a
  separate integration strategy later.
- The decision leaves several implementation details intentionally open, so
  follow-up design work is still required.

## Implementation Notes

- Keep ADR 0001 as the infrastructure and foundation decision.
- Implement auth domain features in later steps without assuming JWT-first
  product authentication.
- Treat MCP and external natural-language administration as roadmap items until
  the API and domain model are ready.

## Related Decisions

- ADR 0001 adopts the Fastify TypeScript service foundation.
