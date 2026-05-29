# Prisma Migration Safety

This repo treats Prisma migrations as both a schema concern and a data preservation concern. When `prisma/schema.prisma` changes, the correct next step is not always a reset. Sometimes the right move is a compatible migration, a staged rollout, or transformation SQL inside `migration.sql`.

The local Codex skill for this workflow lives at `.agents/skills/prisma-migration-safety/`. Use it when working on Prisma schema changes, migration files, drift, reset prompts, backfills, or local backup and restore planning.

## Local Policy

- Do not accept a Prisma reset prompt without first deciding whether current data matters.
- Treat local data as important by default unless the user explicitly says it is disposable.
- Store local operational backups under `.local/backups/`.
- Do not commit dump files.
- Do commit migration SQL under `prisma/migrations/.../migration.sql`.
- Prefer compatible or gradual migrations when existing rows matter.

## Recommended Flow For This Repo

1. Decide whether the change is additive, incompatible, or destructive.
2. If existing data matters, create a backup or define a recovery plan before any risky step.
3. Update `prisma/schema.prisma`.
4. Create and apply the migration with:

   ```powershell
   npm run db:migrate
   ```

5. Review the generated `migration.sql`.
6. If the change touches existing rows, add transformation SQL or split the work into staged migrations.
7. Regenerate Prisma client if needed:

   ```powershell
   npm run db:generate
   ```

8. Reseed or rebootstrap only when the local database was reset or the change invalidates seed/bootstrap assumptions:

   ```powershell
   npm run db:seed
   npm run db:bootstrap-admin -- --email admin@example.com --all-projects
   ```

9. Run the minimum verification set:

   ```powershell
   npm run typecheck
   npm run lint
   npm run test
   npm run build
   ```

## When Prisma Might Ask For Reset

Prisma can ask for reset when:

- the database drifted from migration history
- someone changed the database manually
- a migration was edited or removed after being applied
- the schema change is hard to reconcile cleanly

If that happens, stop and answer these questions before continuing:

- Are the current contents disposable or important?
- Which tables or records need to survive?
- Is there already a backup?
- Can the change be done with a gradual migration instead of reset?
- Does the migration need manual SQL to backfill or transform rows?

## Backup Convention

Use `.local/backups/` for local operational dumps. Suggested names:

- `.local/backups/2026-05-29-before-reset.sql`
- `.local/backups/2026-05-29-before-membership-refactor.dump`

Use:

- `pg_dump` to create dumps
- `psql` to restore `.sql`
- `pg_restore` to restore `.dump`

Do not store dumps in the repo.

## Changes That Usually Need Extra Care

- nullable to required
- enum edits or value replacements
- new unique constraints over existing rows
- renames that Prisma cannot infer safely
- relation rewrites
- dropping tables or columns

When in doubt, prefer:

- no reset
- backup first
- staged migration or transformation SQL
