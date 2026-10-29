-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "incident_source" AS ENUM ('SENTRY', 'DATADOG', 'CLOUDWATCH', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "incident_status" AS ENUM ('RECEIVED', 'VALIDATING', 'NEEDS_REVIEW', 'DRAFT_READY', 'APPROVED', 'SENDING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "validation_status" AS ENUM ('NOT_RUN', 'PASSED', 'MISMATCH', 'UNSUPPORTED', 'ERROR');

-- CreateEnum
CREATE TYPE "audit_event_type" AS ENUM ('INCIDENT_RECEIVED', 'SPEC_REGISTERED', 'SPEC_ACTIVATED', 'VALIDATION_STARTED', 'VALIDATION_COMPLETED', 'VALIDATION_FAILED', 'DRAFT_GENERATED', 'DRAFT_EDITED', 'INCIDENT_APPROVED', 'SEND_SUCCEEDED', 'SEND_FAILED');

-- CreateEnum
CREATE TYPE "actor_type" AS ENUM ('SYSTEM', 'HUMAN');

-- CreateTable
CREATE TABLE "workspaces" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_specs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "api_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "open_api_version" TEXT NOT NULL,
    "source_filename" TEXT NOT NULL,
    "source_text" TEXT NOT NULL,
    "source_sha256" TEXT NOT NULL,
    "parsed_document" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_specs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incidents" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "api_spec_id" UUID,
    "source" "incident_source" NOT NULL,
    "source_event_id" TEXT NOT NULL,
    "http_method" TEXT NOT NULL,
    "request_path" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL,
    "client_reference" TEXT,
    "sanitized_request_body" JSONB,
    "status" "incident_status" NOT NULL DEFAULT 'RECEIVED',
    "validation_status" "validation_status" NOT NULL DEFAULT 'NOT_RUN',
    "validation_evidence" JSONB,
    "draft_text" TEXT,
    "draft_citations" JSONB,
    "draft_version" INTEGER NOT NULL DEFAULT 0,
    "approved_by" TEXT,
    "approved_at" TIMESTAMPTZ(6),
    "approved_draft_version" INTEGER,
    "sent_at" TIMESTAMPTZ(6),
    "processing_error_code" TEXT,
    "processing_error_message" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "incident_id" UUID,
    "event_type" "audit_event_type" NOT NULL,
    "actor_type" "actor_type" NOT NULL,
    "actor_id" TEXT,
    "metadata" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");

-- CreateIndex
CREATE INDEX "api_specs_workspace_id_api_key_is_active_idx" ON "api_specs"("workspace_id", "api_key", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "api_specs_workspace_id_api_key_version_key" ON "api_specs"("workspace_id", "api_key", "version");

-- CreateIndex
CREATE UNIQUE INDEX "api_specs_workspace_id_id_key" ON "api_specs"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "incidents_workspace_id_status_received_at_idx" ON "incidents"("workspace_id", "status", "received_at");

-- CreateIndex
CREATE INDEX "incidents_workspace_id_occurred_at_idx" ON "incidents"("workspace_id", "occurred_at");

-- CreateIndex
CREATE INDEX "incidents_workspace_id_api_spec_id_idx" ON "incidents"("workspace_id", "api_spec_id");

-- CreateIndex
CREATE UNIQUE INDEX "incidents_workspace_id_source_source_event_id_key" ON "incidents"("workspace_id", "source", "source_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "incidents_workspace_id_id_key" ON "incidents"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "audit_logs_workspace_id_created_at_idx" ON "audit_logs"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_workspace_id_incident_id_created_at_idx" ON "audit_logs"("workspace_id", "incident_id", "created_at");

-- AddForeignKey
ALTER TABLE "api_specs" ADD CONSTRAINT "api_specs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_workspace_id_api_spec_id_fkey" FOREIGN KEY ("workspace_id", "api_spec_id") REFERENCES "api_specs"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_workspace_id_incident_id_fkey" FOREIGN KEY ("workspace_id", "incident_id") REFERENCES "incidents"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Enforce HTTP 4xx status codes on incidents
ALTER TABLE "incidents"
ADD CONSTRAINT "incidents_status_code_4xx_check"
CHECK ("status_code" >= 400 AND "status_code" <= 499);

-- At most one active revision per workspace API key
CREATE UNIQUE INDEX "api_specs_one_active_per_api_key_idx"
ON "api_specs" ("workspace_id", "api_key")
WHERE "is_active" = true;

-- Immutable API spec revision content (activation toggles allowed)
CREATE OR REPLACE FUNCTION api_specs_enforce_immutable_revision()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
      OR NEW.api_key IS DISTINCT FROM OLD.api_key
      OR NEW.version IS DISTINCT FROM OLD.version
      OR NEW.open_api_version IS DISTINCT FROM OLD.open_api_version
      OR NEW.source_filename IS DISTINCT FROM OLD.source_filename
      OR NEW.source_text IS DISTINCT FROM OLD.source_text
      OR NEW.source_sha256 IS DISTINCT FROM OLD.source_sha256
      OR NEW.parsed_document IS DISTINCT FROM OLD.parsed_document
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'api_specs revision content is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER api_specs_immutable_revision_trigger
BEFORE UPDATE ON "api_specs"
FOR EACH ROW
EXECUTE FUNCTION api_specs_enforce_immutable_revision();

-- Append-only audit log protections
CREATE OR REPLACE FUNCTION audit_logs_deny_row_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_deny_update_trigger
BEFORE UPDATE ON "audit_logs"
FOR EACH ROW
EXECUTE FUNCTION audit_logs_deny_row_mutation();

CREATE TRIGGER audit_logs_deny_delete_trigger
BEFORE DELETE ON "audit_logs"
FOR EACH ROW
EXECUTE FUNCTION audit_logs_deny_row_mutation();

CREATE OR REPLACE FUNCTION audit_logs_deny_truncate()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'TRUNCATE on audit_logs is not allowed';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_deny_truncate_trigger
BEFORE TRUNCATE ON "audit_logs"
FOR EACH STATEMENT
EXECUTE FUNCTION audit_logs_deny_truncate();
