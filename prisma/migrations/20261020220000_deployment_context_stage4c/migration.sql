CREATE TYPE "deployment_event_status" AS ENUM ('STARTED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'ROLLED_BACK');

ALTER TYPE "audit_event_type" ADD VALUE 'DEPLOYMENT_EVENT_RECORDED';

CREATE TABLE "deployment_records" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "integration_key" TEXT NOT NULL,
    "source_deployment_id" TEXT NOT NULL,
    "api_key" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "repository" TEXT,
    "commit_sha" TEXT,
    "artifact_ref" TEXT,
    "api_spec_id" UUID,
    "replaces_source_deployment_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "deployment_records_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "deployment_status_events" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "deployment_record_id" UUID NOT NULL,
    "integration_key" TEXT NOT NULL,
    "source_event_id" TEXT NOT NULL,
    "status" "deployment_event_status" NOT NULL,
    "source_reported_at" TIMESTAMPTZ(6) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "deployment_status_events_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "investigation_inference_runs"
ADD COLUMN "deployment_evidence_refs" JSONB,
ADD COLUMN "deployment_context_fingerprint" TEXT,
ADD COLUMN "deployment_context_included" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "deployment_records_identity_key"
ON "deployment_records"("workspace_id", "integration_key", "source_deployment_id");

CREATE UNIQUE INDEX "deployment_records_workspace_id_id_key"
ON "deployment_records"("workspace_id", "id");

CREATE INDEX "deployment_records_workspace_service_idx"
ON "deployment_records"("workspace_id", "api_key", "environment", "created_at");

CREATE UNIQUE INDEX "deployment_status_events_idempotent_key"
ON "deployment_status_events"("workspace_id", "integration_key", "source_event_id");

CREATE UNIQUE INDEX "deployment_status_events_workspace_id_id_key"
ON "deployment_status_events"("workspace_id", "id");

CREATE INDEX "deployment_status_events_record_time_idx"
ON "deployment_status_events"("workspace_id", "deployment_record_id", "source_reported_at");

ALTER TABLE "deployment_records"
ADD CONSTRAINT "deployment_records_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "deployment_status_events"
ADD CONSTRAINT "deployment_status_events_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "deployment_status_events"
ADD CONSTRAINT "deployment_status_events_record_fkey"
FOREIGN KEY ("workspace_id", "deployment_record_id")
REFERENCES "deployment_records"("workspace_id", "id")
ON DELETE RESTRICT ON UPDATE CASCADE;
