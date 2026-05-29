---
name: prisma-migration-safety
description: Handle Prisma schema and migration work safely for identity-service. Use when Codex changes `prisma/schema.prisma`, runs `prisma migrate dev`, edits files under `prisma/migrations`, or deals with drift, reset prompts, enum changes, nullability changes, renames, drops, backfills, `pg_dump`, or `pg_restore`. This skill enforces explicit user confirmation before resets or destructive data changes and defaults to preserving data through backups and staged migrations.
---

# Prisma Migration Safety

## Overview

Use this skill to decide whether a Prisma change is safe, needs staged data migration, or requires explicit user approval before any destructive action. Treat local data as important by default.

## Required Workflow

1. Read `AGENTS.md`, `prisma.config.ts`, `prisma/schema.prisma`, `package.json`, and any affected migration files before proposing execution.
2. Classify the change:
   - `additive`: new tables, nullable columns, indexes, optional relations
   - `incompatible`: `NOT NULL`, unique constraints over existing data, enum edits, renames, relation rewrites
   - `destructive`: drops, resets, truncation, replacing data without recovery
3. Assume existing data matters unless the user clearly says otherwise.
4. Before any reset or destructive step, ask the user explicitly:
   - whether current data is disposable
   - what data must be preserved
   - whether a backup already exists
   - whether they want a gradual migration instead of reset
5. If data must be preserved, prefer:
   - additive migration first
   - backfill or transformation SQL in `migration.sql`
   - expand/contract over one-shot destructive changes
6. Use `.local/backups/` as the default local backup directory and keep dumps out of Git.
7. After schema work, use the repo workflow that applies:

```powershell
npm run db:migrate
npm run db:generate
npm run db:seed
npm run db:bootstrap-admin -- --email admin@example.com --all-projects
npm run typecheck
npm run lint
npm run test
npm run build
```

Only run the seed and bootstrap steps when the schema change or local reset invalidates seeded data or admin setup.

## Reset Rules

- Never accept a Prisma reset prompt silently.
- Never reset when the user has not answered the data preservation questions.
- If the user does not answer yet, default to:
  - do not reset
  - preserve data
  - propose a backup in `.local/backups/`
  - propose a compatible or staged migration plan
- If reset is acceptable because data is disposable, state the consequence clearly before running it.

## Data Preservation Rules

- Version migration SQL in `prisma/migrations/.../migration.sql` when it is part of the system's evolution.
- Do not version `pg_dump` outputs or restored data snapshots.
- When a schema change requires transforming existing rows, put the transformation in the migration SQL or in a staged migration plan, not in a one-off undocumented terminal step.
- Prefer expand/contract for renames, enum replacements, and nullability changes that touch live data.
- When planning backfills or transformations, read `references/data-preservation-playbook.md`.

## Backup and Restore Defaults

- Default backup path: `.local/backups/<timestamp>-<purpose>.sql` or `.dump`
- Prefer `pg_dump -Fc` for richer restore workflows.
- Use `psql` to restore `.sql` files and `pg_restore` to restore `.dump` files.
- Read `references/postgres-backup-restore.md` before proposing backup or restore commands.

## What To Ask The User

Ask these questions before resets or destructive migrations:

- Do the current database contents matter, or are they disposable?
- Which tables or records must be preserved?
- Do you already have a backup, or should one be created now?
- Do you want a gradual migration that preserves data, even if it takes more steps?
- Is manual SQL in `migration.sql` acceptable for a clean transformation?

## References

- Read `references/reset-decision-guide.md` when Prisma reports drift or asks for reset.
- Read `references/data-preservation-playbook.md` when changing enums, required fields, unique constraints, renames, relations, or any shape that touches existing rows.
- Read `references/postgres-backup-restore.md` before suggesting `pg_dump`, `pg_restore`, or `psql` commands.
