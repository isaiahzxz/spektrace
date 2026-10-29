-- Stage 2: investigation grouping and evidence preparation

CREATE TYPE "evidence_preparation_run_status" AS ENUM (
  'PENDING',
  'RUNNING',
  'EVIDENCE_READY',
  'FAILED'
);

ALTER TYPE "outbox_event_type" ADD VALUE 'INCIDENT_INVESTIGATION_GROUPING_REQUESTED';
ALTER TYPE "outbox_event_type" ADD VALUE 'INVESTIGATION_GROUP_PREPARATION_REQUESTED';

ALTER TABLE "outbox_events" ADD COLUMN "investigation_group_id" UUID;
ALTER TABLE "outbox_events" ADD COLUMN "dedupe_key" TEXT;

UPDATE "outbox_events"
SET "dedupe_key" = 'validation:' || "incident_id"::text
WHERE "dedupe_key" IS NULL;

ALTER TABLE "outbox_events" ALTER COLUMN "dedupe_key" SET NOT NULL;
ALTER TABLE "outbox_events" ALTER COLUMN "incident_id" DROP NOT NULL;

DROP INDEX IF EXISTS "outbox_events_workspace_id_incident_id_event_type_key";
CREATE UNIQUE INDEX "outbox_events_workspace_id_dedupe_key_key"
  ON "outbox_events" ("workspace_id", "dedupe_key");

CREATE TABLE "investigation_groups" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "api_key" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "http_method" TEXT NOT NULL,
  "operation_identity" TEXT NOT NULL,
  "api_spec_id" UUID,
  "pinned_api_spec_key" TEXT NOT NULL,
  "finding_signature" TEXT NOT NULL,
  "window_start" TIMESTAMPTZ(6) NOT NULL,
  "window_end" TIMESTAMPTZ(6) NOT NULL,
  "membership_version" INTEGER NOT NULL DEFAULT 0,
  "prepared_membership_version" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "investigation_groups_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "investigation_group_memberships" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "investigation_group_id" UUID NOT NULL,
  "incident_id" UUID NOT NULL,
  "incident_received_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "investigation_group_memberships_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "evidence_preparation_runs" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "investigation_group_id" UUID NOT NULL,
  "run_sequence" INTEGER NOT NULL,
  "membership_version" INTEGER NOT NULL,
  "status" "evidence_preparation_run_status" NOT NULL DEFAULT 'PENDING',
  "included_incident_count" INTEGER NOT NULL DEFAULT 0,
  "omitted_incident_count" INTEGER NOT NULL DEFAULT 0,
  "evidence_format_version" INTEGER NOT NULL,
  "builder_version" TEXT NOT NULL,
  "protected_summary" JSONB,
  "failure_code" TEXT,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "claimed_at" TIMESTAMPTZ(6),
  "claim_expires_at" TIMESTAMPTZ(6),
  "claimed_by" TEXT,
  "started_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "evidence_preparation_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "investigation_groups_workspace_id_id_key"
  ON "investigation_groups" ("workspace_id", "id");

CREATE UNIQUE INDEX "investigation_groups_grouping_dimensions_key"
  ON "investigation_groups" (
    "workspace_id",
    "api_key",
    "environment",
    "http_method",
    "operation_identity",
    "pinned_api_spec_key",
    "finding_signature",
    "window_start"
  );

CREATE INDEX "investigation_groups_workspace_id_window_start_idx"
  ON "investigation_groups" ("workspace_id", "window_start");

CREATE UNIQUE INDEX "investigation_group_memberships_workspace_id_incident_id_key"
  ON "investigation_group_memberships" ("workspace_id", "incident_id");

CREATE UNIQUE INDEX "investigation_group_memberships_workspace_group_incident_key"
  ON "investigation_group_memberships" ("workspace_id", "investigation_group_id", "incident_id");

CREATE INDEX "investigation_group_memberships_group_received_idx"
  ON "investigation_group_memberships" ("workspace_id", "investigation_group_id", "incident_received_at");

CREATE UNIQUE INDEX "evidence_preparation_runs_workspace_group_sequence_key"
  ON "evidence_preparation_runs" ("workspace_id", "investigation_group_id", "run_sequence");

CREATE INDEX "evidence_preparation_runs_status_claim_idx"
  ON "evidence_preparation_runs" ("status", "claim_expires_at", "created_at");

ALTER TABLE "investigation_groups"
  ADD CONSTRAINT "investigation_groups_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "investigation_groups"
  ADD CONSTRAINT "investigation_groups_workspace_id_api_spec_id_fkey"
  FOREIGN KEY ("workspace_id", "api_spec_id") REFERENCES "api_specs"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "investigation_group_memberships"
  ADD CONSTRAINT "investigation_group_memberships_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "investigation_group_memberships"
  ADD CONSTRAINT "investigation_group_memberships_workspace_group_fkey"
  FOREIGN KEY ("workspace_id", "investigation_group_id") REFERENCES "investigation_groups"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "investigation_group_memberships"
  ADD CONSTRAINT "investigation_group_memberships_workspace_incident_fkey"
  FOREIGN KEY ("workspace_id", "incident_id") REFERENCES "incidents"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "evidence_preparation_runs"
  ADD CONSTRAINT "evidence_preparation_runs_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "evidence_preparation_runs"
  ADD CONSTRAINT "evidence_preparation_runs_workspace_group_fkey"
  FOREIGN KEY ("workspace_id", "investigation_group_id") REFERENCES "investigation_groups"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "outbox_events"
  ADD CONSTRAINT "outbox_events_workspace_id_investigation_group_id_fkey"
  FOREIGN KEY ("workspace_id", "investigation_group_id") REFERENCES "investigation_groups"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
