-- CreateEnum
CREATE TYPE "ServicePrincipalStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "AdminOperationStatus" AS ENUM ('COMPLETED', 'PENDING_APPROVAL', 'DENIED', 'FAILED');

-- CreateEnum
CREATE TYPE "AdminActionEventType" AS ENUM ('REQUESTED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'COMPLETED', 'DENIED', 'FAILED');

-- CreateEnum
CREATE TYPE "AdminApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- AlterEnum
ALTER TYPE "ProjectMembershipAuditAction" ADD VALUE 'READMITTED';

-- CreateTable
CREATE TABLE "service_principals" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "ServicePrincipalStatus" NOT NULL DEFAULT 'ACTIVE',
    "secret_hash" TEXT NOT NULL,
    "all_projects" BOOLEAN NOT NULL DEFAULT false,
    "last_used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "service_principals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_principal_project_scopes" (
    "service_principal_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_principal_project_scopes_pkey" PRIMARY KEY ("service_principal_id","project_id")
);

-- CreateTable
CREATE TABLE "admin_operations" (
    "id" TEXT NOT NULL,
    "operation_name" TEXT NOT NULL,
    "status" "AdminOperationStatus" NOT NULL,
    "service_principal_id" TEXT,
    "operator_user_id" TEXT,
    "source_channel" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "correlation_id" TEXT,
    "reason" TEXT,
    "ticket_ref" TEXT,
    "target_project_id" TEXT,
    "target_user_id" TEXT,
    "target_session_id" TEXT,
    "policy_version" TEXT,
    "error_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "admin_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_action_audits" (
    "id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "event_type" "AdminActionEventType" NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_user_id" TEXT,
    "detail" TEXT,
    "request_snapshot_json" JSONB,
    "result_snapshot_json" JSONB,
    "error_code" TEXT,

    CONSTRAINT "admin_action_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_approvals" (
    "id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "status" "AdminApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "requested_by_user_id" TEXT,
    "required_approval_level" TEXT NOT NULL,
    "approved_by_user_id" TEXT,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(3),
    "decision_reason" TEXT,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "admin_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_principals_slug_key" ON "service_principals"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "service_principals_secret_hash_key" ON "service_principals"("secret_hash");

-- CreateIndex
CREATE INDEX "service_principals_status_idx" ON "service_principals"("status");

-- CreateIndex
CREATE INDEX "service_principal_project_scopes_project_id_idx" ON "service_principal_project_scopes"("project_id");

-- CreateIndex
CREATE INDEX "admin_operations_status_idx" ON "admin_operations"("status");

-- CreateIndex
CREATE INDEX "admin_operations_correlation_id_idx" ON "admin_operations"("correlation_id");

-- CreateIndex
CREATE INDEX "admin_operations_created_at_idx" ON "admin_operations"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "admin_operations_principal_idempotency_key" ON "admin_operations"("service_principal_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "admin_action_audits_operation_id_idx" ON "admin_action_audits"("operation_id");

-- CreateIndex
CREATE INDEX "admin_action_audits_event_type_idx" ON "admin_action_audits"("event_type");

-- CreateIndex
CREATE INDEX "admin_action_audits_occurred_at_idx" ON "admin_action_audits"("occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "admin_approvals_operation_id_key" ON "admin_approvals"("operation_id");

-- CreateIndex
CREATE INDEX "admin_approvals_status_idx" ON "admin_approvals"("status");

-- CreateIndex
CREATE INDEX "admin_approvals_expires_at_idx" ON "admin_approvals"("expires_at");

-- AddForeignKey
ALTER TABLE "service_principal_project_scopes" ADD CONSTRAINT "service_principal_project_scopes_service_principal_id_fkey" FOREIGN KEY ("service_principal_id") REFERENCES "service_principals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_principal_project_scopes" ADD CONSTRAINT "service_principal_project_scopes_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_operations" ADD CONSTRAINT "admin_operations_service_principal_id_fkey" FOREIGN KEY ("service_principal_id") REFERENCES "service_principals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_action_audits" ADD CONSTRAINT "admin_action_audits_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "admin_operations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_approvals" ADD CONSTRAINT "admin_approvals_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "admin_operations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
