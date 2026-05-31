-- CreateEnum
CREATE TYPE "ProjectMembershipAuditAction" AS ENUM ('CREATED', 'ROLES_REPLACED', 'SUSPENDED', 'REACTIVATED', 'REVOKED');

-- CreateTable
CREATE TABLE "project_membership_audit_logs" (
    "id" TEXT NOT NULL,
    "action" "ProjectMembershipAuditAction" NOT NULL,
    "project_id" TEXT NOT NULL,
    "membership_id" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "target_user_id" TEXT NOT NULL,
    "from_status" "MembershipStatus",
    "to_status" "MembershipStatus",
    "from_role_codes" TEXT[],
    "to_role_codes" TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_membership_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_membership_audit_logs_project_id_idx" ON "project_membership_audit_logs"("project_id");

-- CreateIndex
CREATE INDEX "project_membership_audit_logs_membership_id_idx" ON "project_membership_audit_logs"("membership_id");

-- CreateIndex
CREATE INDEX "project_membership_audit_logs_actor_user_id_idx" ON "project_membership_audit_logs"("actor_user_id");

-- CreateIndex
CREATE INDEX "project_membership_audit_logs_target_user_id_idx" ON "project_membership_audit_logs"("target_user_id");

-- CreateIndex
CREATE INDEX "project_membership_audit_logs_action_idx" ON "project_membership_audit_logs"("action");

-- CreateIndex
CREATE INDEX "project_membership_audit_logs_created_at_idx" ON "project_membership_audit_logs"("created_at");

-- AddForeignKey
ALTER TABLE "project_membership_audit_logs" ADD CONSTRAINT "project_membership_audit_logs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_membership_audit_logs" ADD CONSTRAINT "project_membership_audit_logs_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "project_memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_membership_audit_logs" ADD CONSTRAINT "project_membership_audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_membership_audit_logs" ADD CONSTRAINT "project_membership_audit_logs_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
