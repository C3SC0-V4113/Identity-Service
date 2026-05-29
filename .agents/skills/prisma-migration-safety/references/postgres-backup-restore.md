# PostgreSQL Backup And Restore

Use this guide before proposing `pg_dump`, `psql`, or `pg_restore` commands for local migration safety.

## Local Backup Location

Use `.local/backups/` by default. This path is ignored by Git and is meant for local operational artifacts only.

Suggested names:

- `.local/backups/2026-05-29-before-reset.sql`
- `.local/backups/2026-05-29-before-enum-change.dump`

Create the directory first if it does not exist.

## Preferred Backup Formats

### Plain SQL

Good for simple inspection and replay.

```powershell
pg_dump "$env:DATABASE_URL" > .local/backups/2026-05-29-before-change.sql
```

Restore with:

```powershell
psql "$env:DATABASE_URL" -f .local/backups/2026-05-29-before-change.sql
```

### Custom Dump

Prefer this when a richer restore workflow is useful.

```powershell
pg_dump -Fc "$env:DATABASE_URL" -f .local/backups/2026-05-29-before-change.dump
```

Restore with:

```powershell
pg_restore --dbname="$env:DATABASE_URL" .local/backups/2026-05-29-before-change.dump
```

To replace existing objects during restore:

```powershell
pg_restore --clean --if-exists --dbname="$env:DATABASE_URL" .local/backups/2026-05-29-before-change.dump
```

## Table-Scoped Backup

If only part of the identity data matters, back up specific tables:

```powershell
pg_dump "$env:DATABASE_URL" -t users -t local_credentials -t sessions -t project_memberships -t project_membership_roles > .local/backups/2026-05-29-identity-subset.sql
```

## Restore Warnings

- Do not restore over a non-empty database casually.
- Existing tables, constraints, or rows may conflict with the dump.
- A restore can duplicate or replace data depending on the command and current state.
- If the goal is full replacement, prefer a clean database or use `pg_restore --clean --if-exists` with care.

## Repo Context

After a destructive reset or full rebuild in this repo, the usual rebuild flow is:

```powershell
npm run db:migrate
npm run db:seed
npm run db:bootstrap-admin -- --email admin@example.com --all-projects
```

That rebuilds base schema, seeded projects and roles, and project admins, but not ad hoc users or memberships unless those were recreated separately.
