-- Stage 3: bounded AI investigation inference

CREATE TYPE "investigation_inference_run_status" AS ENUM (
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED'
);

ALTER TYPE "outbox_event_type" ADD VALUE 'INVESTIGATION_GROUP_INFERENCE_REQUESTED';

ALTER TABLE "investigation_groups"
  ADD COLUMN "inferred_membership_version" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "outbox_events"
  ADD COLUMN "evidence_preparation_run_id" UUID;

ALTER TABLE "evidence_preparation_runs"
  ADD CONSTRAINT "evidence_preparation_runs_workspace_id_id_key"
  UNIQUE ("workspace_id", "id");

CREATE TABLE "investigation_inference_runs" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "investigation_group_id" UUID NOT NULL,
  "evidence_preparation_run_id" UUID NOT NULL,
  "run_sequence" INTEGER NOT NULL,
  "membership_version" INTEGER NOT NULL,
  "evidence_input_hash" TEXT NOT NULL,
  "prompt_schema_version" TEXT NOT NULL,
  "provider" TEXT,
  "model" TEXT,
  "status" "investigation_inference_run_status" NOT NULL DEFAULT 'PENDING',
  "included_evidence_count" INTEGER NOT NULL DEFAULT 0,
  "unavailable_evidence_count" INTEGER NOT NULL DEFAULT 0,
  "omitted_evidence_count" INTEGER NOT NULL DEFAULT 0,
  "validated_output" JSONB,
  "failure_code" TEXT,
  "usage_metadata" JSONB,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "claimed_at" TIMESTAMPTZ(6),
  "claim_expires_at" TIMESTAMPTZ(6),
  "claimed_by" TEXT,
  "started_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "investigation_inference_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "investigation_inference_runs_workspace_id_investigation_group_id_run_sequence_key"
  ON "investigation_inference_runs" ("workspace_id", "investigation_group_id", "run_sequence");

CREATE INDEX "investigation_inference_runs_workspace_id_evidence_preparation_run_id_idx"
  ON "investigation_inference_runs" ("workspace_id", "evidence_preparation_run_id");

CREATE INDEX "investigation_inference_runs_status_claim_expires_at_created_at_idx"
  ON "investigation_inference_runs" ("status", "claim_expires_at", "created_at");

ALTER TABLE "investigation_inference_runs"
  ADD CONSTRAINT "investigation_inference_runs_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "investigation_inference_runs"
  ADD CONSTRAINT "investigation_inference_runs_workspace_id_investigation_group_id_fkey"
  FOREIGN KEY ("workspace_id", "investigation_group_id") REFERENCES "investigation_groups"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "investigation_inference_runs"
  ADD CONSTRAINT "investigation_inference_runs_workspace_id_evidence_preparation_run_id_fkey"
  FOREIGN KEY ("workspace_id", "evidence_preparation_run_id") REFERENCES "evidence_preparation_runs"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "outbox_events"
  ADD CONSTRAINT "outbox_events_workspace_id_evidence_preparation_run_id_fkey"
  FOREIGN KEY ("workspace_id", "evidence_preparation_run_id") REFERENCES "evidence_preparation_runs"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
