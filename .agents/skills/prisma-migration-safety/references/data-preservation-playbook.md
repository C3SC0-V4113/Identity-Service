# Data Preservation Playbook

Use this guide when a Prisma change affects existing rows and the goal is to keep the data.

## Core Rule

Ask: what happens to rows that already exist?

If the answer is unclear, the migration plan is not ready.

## Preferred Strategies

## 1. Additive Migration

Use when the schema change can be introduced without breaking existing rows.

Examples:

- add nullable column
- add new table
- add optional relation

This is the simplest path and usually keeps data intact with no extra SQL.

## 2. Expand / Contract

Use when the final shape is incompatible but the transition can be staged.

Typical flow:

1. Expand with compatible schema.
2. Backfill or dual-write.
3. Switch application reads and writes.
4. Remove old shape in a later migration.

Use this for:

- renames
- semantic replacements
- relation rewrites
- large data moves

## 3. Transformation SQL In `migration.sql`

Use when a single migration needs to reshape current data as part of the schema change.

Good cases:

- fill required values before adding `NOT NULL`
- rewrite enum-backed semantics
- migrate data from old column to new column
- normalize rows before adding constraints

Version this SQL in the migration folder. Do not leave it as an undocumented one-off terminal command.

## Common Cases

## Nullable To Required

Bad plan:

- change Prisma field to required
- run migration without preparing existing rows

Good plan:

1. decide the source of replacement values
2. update existing rows in SQL
3. enforce `NOT NULL`

## Rename Or Semantic Replacement

Do not rely on reset just because Prisma cannot infer intent.

Prefer:

1. add the new field or state
2. copy or transform data
3. update the app
4. remove the old field later

## Enum Changes

Treat enum edits as data changes, not only schema changes.

Before removing or replacing enum values, determine:

- which rows currently use them
- which target value should replace them
- whether the replacement is one-to-one or requires business logic

## Unique Constraints

Before adding a unique constraint, determine whether duplicates already exist.

If duplicates exist, define the cleanup strategy first:

- merge
- choose canonical row
- delete redundant rows
- split data into another table

## Relationship Rewrites

When moving from one relation shape to another:

1. create the new relation shape
2. backfill it
3. switch reads and writes
4. remove the old relation later

## Backup Policy For This Repo

- Put local operational dumps under `.local/backups/`.
- Do not commit dump files.
- Prefer timestamped names such as:
  - `.local/backups/2026-05-29-before-membership-refactor.dump`
  - `.local/backups/2026-05-29-before-required-display-name.sql`

## Decision Rule

If preserving data matters and the migration is not additive, default to:

- no reset
- backup first
- staged migration or transformation SQL
