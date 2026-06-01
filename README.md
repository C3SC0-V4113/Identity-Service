# Identity Service

Identity and access backend for portfolio projects and demos.

`identity-service` is intended to become the central identity service for a
portfolio of projects. It will own shared user identities while each project
keeps its own access rules, roles, and project-specific associated
information.

The expected authentication model is stateful and session-based. Product
authentication should rely on server-managed sessions that can be revoked and
renewed over time. Stateless JWT authentication is not the intended primary
product model for this service.

The repository already includes the initial auth and project-membership
surface on top of the Fastify + TypeScript base, environment validation,
Prisma setup, health checks, and quality tooling. Broader admin tooling,
OpenClaw admin operations, and MCP tools remain future steps.

Current design references:

- [ADR 0002: Adopt Session-Based Portfolio Identity](./docs/adrs/0002-adopt-session-based-portfolio-identity.md)
- [ADR 0003: Define Initial Identity Data Model](./docs/adrs/0003-define-initial-identity-data-model.md)
- [ADR 0004: Record Project Membership Audit Logs](./docs/adrs/0004-record-project-membership-audit-logs.md)
- [ADR 0005: Expose Project Membership Audit Read API](./docs/adrs/0005-expose-project-membership-audit-read-api.md)
- [ADR 0006: Self-Service Session Management](./docs/adrs/0006-self-service-session-management.md)
- [ADR 0007: Scope Auth to Projects and Move Session Control to Project Admins](./docs/adrs/0007-scope-auth-to-project-and-move-session-control-to-admins.md)
- [Database Model](./docs/database-model.md)
- [Checkpoints](./docs/checkpoints.md)

Current implementation highlights:

- Project-scoped auth endpoints under `/projects/:slug/auth/*`.
- Two-step registration with project email check before account creation.
- Login auto-admits an existing ecosystem user into a project with the default
  `user` role when they do not yet have a membership there.
- `GET /projects/:slug/auth/session` is the lightweight middleware-friendly
  endpoint for checking whether the current project session is still valid.
- Sessions are issued per project and cannot be reused across projects.
- Project-admin session management with `GET /projects/:slug/sessions` and
  `POST /projects/:slug/sessions/:sessionId/revoke`.
- Project role seeds for `other-gpt` and `cost-console`.
- Project-scoped access introspection with `GET /projects/:slug/me`.
- Admin-only membership listing, admission, lifecycle management, and role
  replacement within a project.
- Structured audit logging for successful project membership mutations.
- Admin-only membership audit history reads with `GET /projects/:slug/audit-logs`,
  including action/target/membership filtering and cursor pagination.
- Project-scoped membership and access endpoints are blocked when the target
  project is disabled.

## Local setup

1. Copy `.env.example` to `.env`.
2. Start PostgreSQL with Docker:

   ```powershell
   docker compose up -d
   ```

3. The default local connection string is:

   ```env
   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/identity_service
   ```

4. If this is the first run, generate the Prisma client and apply migrations:

   ```powershell
   npm run db:generate
   npm run db:migrate
   ```

5. Seed the project and role bootstrap data:

   ```powershell
   npm run db:seed
   ```

6. Bootstrap the first project admin after the user exists:

   ```powershell
   npm run db:bootstrap-admin -- --email admin@example.com --all-projects
   ```

7. Start the API:

   ```powershell
   npm run dev
   ```

`npm run dev` and `npm start` load `.env` automatically when the file exists in the project root.
