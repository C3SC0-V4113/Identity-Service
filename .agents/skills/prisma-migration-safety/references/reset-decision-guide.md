# Reset Decision Guide

Use this guide when `prisma migrate dev` reports drift, wants to reset the database, or when a migration plan might replace data.

## Default Stance

- Assume current data matters.
- Do not accept reset until the user explicitly confirms either:
  - the data is disposable, or
  - a backup and recovery plan is in place.

## Questions To Resolve First

1. Does the database contain data the user wants to keep?
2. Which tables or records matter?
3. Is there already a recent backup?
4. Can the change be made with an additive or staged migration?
5. Would a reset save time only because the migration plan is incomplete?

## When Reset Is Usually Acceptable

- The database is local-only and fully disposable.
- The user explicitly says the current data can be lost.
- The state can be rebuilt cheaply with:

```powershell
npm run db:migrate
npm run db:seed
npm run db:bootstrap-admin -- --email admin@example.com --all-projects
```

- Losing ad hoc users, sessions, and memberships is acceptable.

## When Reset Is Usually Not Acceptable

- The user wants to keep test users, memberships, or validation data.
- The schema change touches rows that can be transformed safely.
- Prisma wants reset because of drift, but the real issue is an incomplete migration plan.
- The change removes columns, values, or relationships that currently contain useful data.

## Common Drift Signals

- `prisma migrate dev` says the database schema is not in sync with migration history.
- Someone changed the database manually outside Prisma.
- Someone edited or removed a migration that was already applied.
- The local database was reset or imported from another source without matching migration history.

## Classify The Change

### Additive

Examples:

- add a new table
- add a nullable column
- add an index
- add an optional relation

These often do not need reset and rarely need data transformation.

### Incompatible

Examples:

- nullable to required
- add unique constraint over existing rows
- rename a column or semantic value
- remove or replace enum values
- rewrite relationships

These usually need staged migration or transformation SQL.

### Destructive

Examples:

- drop a table or column
- truncate or replace rows
- accept reset that will wipe the local database

These always require explicit user approval and a data plan.

## Recommended Response To A Reset Prompt

1. Stop.
2. Explain that reset may wipe local data.
3. Ask whether the data is disposable.
4. If not disposable, propose:
   - backup in `.local/backups/`
   - a staged migration or SQL transformation plan
5. Only proceed after the user confirms the intended path.
