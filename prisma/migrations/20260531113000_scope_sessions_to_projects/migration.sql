ALTER TABLE "sessions"
ADD COLUMN "project_id" TEXT;

UPDATE "sessions"
SET
  "status" = 'REVOKED',
  "revoked_at" = COALESCE("revoked_at", NOW()),
  "revoked_reason" = COALESCE("revoked_reason", 'LEGACY_GLOBAL_SESSION')
WHERE "project_id" IS NULL
  AND "status" = 'ACTIVE';

CREATE INDEX "sessions_project_id_idx" ON "sessions"("project_id");

CREATE INDEX "sessions_project_id_status_idx" ON "sessions"("project_id", "status");

ALTER TABLE "sessions"
ADD CONSTRAINT "sessions_project_id_fkey"
FOREIGN KEY ("project_id") REFERENCES "projects"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;
