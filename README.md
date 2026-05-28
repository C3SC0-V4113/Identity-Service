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

The repository is still in the foundation phase. The current implementation
focuses on the Fastify + TypeScript base, environment validation, Prisma
setup, health checks, and quality tooling. Auth domain capabilities such as
users, credentials, sessions, project roles, audit logs, OpenClaw admin
operations, and MCP tools will be implemented in later steps.

Current design references:

- [ADR 0002: Adopt Session-Based Portfolio Identity](./docs/adrs/0002-adopt-session-based-portfolio-identity.md)
- [ADR 0003: Define Initial Identity Data Model](./docs/adrs/0003-define-initial-identity-data-model.md)
- [Database Model](./docs/database-model.md)

Near-term roadmap:

- Central identity for multiple portfolio projects.
- Project-specific authorization, roles, and related metadata.
- Revocable and renewable session management.
- External MCP/admin tooling to create and delete users, ban or unban them,
  change their roles, and revoke or manage sessions through natural-language
  workflows.

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

5. Start the API:

   ```powershell
   npm run dev
   ```

`npm run dev` and `npm start` load `.env` automatically when the file exists in the project root.
