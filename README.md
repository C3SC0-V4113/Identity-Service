# Identity Service

Identity and access backend for portfolio demos.

This service starts with a Fastify + TypeScript foundation. Auth domain features such as users, credentials, sessions, project roles, audit logs, OpenClaw admin operations, and MCP tools will be implemented in later steps.

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
