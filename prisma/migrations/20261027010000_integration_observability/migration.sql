SET lock_timeout = '5s';
SET statement_timeout = '30s';
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "audit_event_type" ADD VALUE 'INTEGRATION_OBSERVATION_RECEIVED';
ALTER TYPE "audit_event_type" ADD VALUE 'INTEGRATION_BASELINE_CREATED';
ALTER TYPE "audit_event_type" ADD VALUE 'INTEGRATION_BASELINE_ACTIVATED';
ALTER TYPE "audit_event_type" ADD VALUE 'INTEGRATION_OUTCOME_RECEIVED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "outbox_event_type" ADD VALUE 'INTEGRATION_OBSERVATION_REQUESTED';
ALTER TYPE "outbox_event_type" ADD VALUE 'INTEGRATION_OUTCOME_REQUESTED';

-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     "integration_observation_id" UUID,
ADD COLUMN     "integration_outcome_id" UUID;

-- CreateTable
CREATE TABLE "integration_observations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "collector_credential_id" UUID NOT NULL,
    "source_event_id" UUID NOT NULL,
    "call_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "integration_key" TEXT NOT NULL,
    "provider_key" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "http_method" TEXT NOT NULL,
    "operation_path" TEXT NOT NULL,
    "correlation_kind" TEXT,
    "correlation_id" UUID,
    "correlation_attempt" INTEGER,
    "result_kind" TEXT NOT NULL,
    "status_code" INTEGER,
    "duration_ms" DOUBLE PRECISION NOT NULL,
    "scope_key" TEXT NOT NULL,
    "baseline_id" UUID,
    "request_incident_id" UUID,
    "envelope" JSONB NOT NULL,
    "payload_digest" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processing_state" TEXT NOT NULL DEFAULT 'PENDING',
    "detector_evidence" JSONB,
    "drift_signature" TEXT,
    "processed_at" TIMESTAMPTZ(6),
    "link_truncated" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "integration_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_response_baselines" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "scope_key" TEXT NOT NULL,
    "integration_key" TEXT NOT NULL,
    "provider_key" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "http_method" TEXT NOT NULL,
    "operation_path" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "origin" TEXT NOT NULL,
    "sample_observation_id" UUID,
    "api_spec_id" UUID,
    "source_sha256" TEXT,
    "expected_shape" JSONB NOT NULL,
    "pointers" JSONB NOT NULL,
    "import_digest" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activated_at" TIMESTAMPTZ(6),

    CONSTRAINT "integration_response_baselines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_workflow_outcomes" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "collector_credential_id" UUID NOT NULL,
    "source_event_id" UUID NOT NULL,
    "integration_key" TEXT NOT NULL,
    "provider_key" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "correlation_kind" TEXT NOT NULL,
    "correlation_id" UUID NOT NULL,
    "correlation_attempt" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "envelope" JSONB NOT NULL,
    "payload_digest" TEXT NOT NULL,
    "processing_state" TEXT NOT NULL DEFAULT 'PENDING',
    "processed_at" TIMESTAMPTZ(6),
    "link_truncated" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "integration_workflow_outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_outcome_links" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "observation_id" UUID NOT NULL,
    "outcome_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_outcome_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_capture_coverage" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "collector_credential_id" UUID NOT NULL,
    "source_event_id" UUID NOT NULL,
    "instance_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "integration_key" TEXT NOT NULL,
    "provider_key" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "envelope" JSONB NOT NULL,
    "payload_digest" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_capture_coverage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "integration_observation_scope_idx" ON "integration_observations"("workspace_id", "integration_key", "environment", "received_at");

-- CreateIndex
CREATE INDEX "integration_observation_correlation_idx" ON "integration_observations"("workspace_id", "integration_key", "environment", "correlation_kind", "correlation_id", "correlation_attempt");

-- CreateIndex
CREATE INDEX "integration_observation_drift_idx" ON "integration_observations"("workspace_id", "baseline_id", "drift_signature");

-- CreateIndex
CREATE INDEX "integration_observation_collector_idx" ON "integration_observations"("workspace_id", "collector_credential_id");

-- CreateIndex
CREATE INDEX "integration_observation_incident_idx" ON "integration_observations"("workspace_id", "request_incident_id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_observations_workspace_id_id_key" ON "integration_observations"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_observations_workspace_id_source_event_id_key" ON "integration_observations"("workspace_id", "source_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_observation_attempt_key" ON "integration_observations"("workspace_id", "integration_key", "environment", "call_id", "attempt");

-- CreateIndex
CREATE INDEX "integration_baseline_sample_idx" ON "integration_response_baselines"("workspace_id", "sample_observation_id");

-- CreateIndex
CREATE INDEX "integration_baseline_spec_idx" ON "integration_response_baselines"("workspace_id", "api_spec_id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_response_baselines_workspace_id_id_key" ON "integration_response_baselines"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_baseline_version_key" ON "integration_response_baselines"("workspace_id", "scope_key", "version");

-- CreateIndex
CREATE UNIQUE INDEX "integration_baseline_import_key" ON "integration_response_baselines"("workspace_id", "scope_key", "import_digest");

-- CreateIndex
CREATE INDEX "integration_outcome_scope_idx" ON "integration_workflow_outcomes"("workspace_id", "integration_key", "environment", "received_at");

-- CreateIndex
CREATE INDEX "integration_outcome_collector_idx" ON "integration_workflow_outcomes"("workspace_id", "collector_credential_id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_workflow_outcomes_workspace_id_id_key" ON "integration_workflow_outcomes"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_workflow_outcomes_workspace_id_source_event_id_key" ON "integration_workflow_outcomes"("workspace_id", "source_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_outcome_attempt_key" ON "integration_workflow_outcomes"("workspace_id", "integration_key", "environment", "correlation_kind", "correlation_id", "correlation_attempt");

-- CreateIndex
CREATE INDEX "integration_link_outcome_idx" ON "integration_outcome_links"("workspace_id", "outcome_id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_link_pair_key" ON "integration_outcome_links"("workspace_id", "observation_id", "outcome_id");

-- CreateIndex
CREATE INDEX "integration_coverage_scope_idx" ON "integration_capture_coverage"("workspace_id", "integration_key", "environment", "received_at");

-- CreateIndex
CREATE INDEX "integration_coverage_collector_idx" ON "integration_capture_coverage"("workspace_id", "collector_credential_id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_capture_coverage_workspace_id_source_event_id_key" ON "integration_capture_coverage"("workspace_id", "source_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_coverage_sequence_key" ON "integration_capture_coverage"("workspace_id", "instance_id", "sequence");

-- CreateIndex
CREATE INDEX "outbox_integration_observation_idx" ON "outbox_events"("workspace_id", "integration_observation_id");

-- CreateIndex
CREATE INDEX "outbox_integration_outcome_idx" ON "outbox_events"("workspace_id", "integration_outcome_id");

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_integration_observation_fk" FOREIGN KEY ("workspace_id", "integration_observation_id") REFERENCES "integration_observations"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_integration_outcome_fk" FOREIGN KEY ("workspace_id", "integration_outcome_id") REFERENCES "integration_workflow_outcomes"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "integration_observations" ADD CONSTRAINT "integration_observations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "integration_observations" ADD CONSTRAINT "integration_observation_collector_fk" FOREIGN KEY ("workspace_id", "collector_credential_id") REFERENCES "ingestion_credentials"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "integration_observations" ADD CONSTRAINT "integration_observation_baseline_fk" FOREIGN KEY ("workspace_id", "baseline_id") REFERENCES "integration_response_baselines"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "integration_observations" ADD CONSTRAINT "integration_observation_incident_fk" FOREIGN KEY ("workspace_id", "request_incident_id") REFERENCES "incidents"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "integration_response_baselines" ADD CONSTRAINT "integration_response_baselines_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "integration_response_baselines" ADD CONSTRAINT "integration_baseline_sample_fk" FOREIGN KEY ("workspace_id", "sample_observation_id") REFERENCES "integration_observations"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "integration_response_baselines" ADD CONSTRAINT "integration_baseline_spec_fk" FOREIGN KEY ("workspace_id", "api_spec_id") REFERENCES "api_specs"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "integration_workflow_outcomes" ADD CONSTRAINT "integration_workflow_outcomes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "integration_workflow_outcomes" ADD CONSTRAINT "integration_outcome_collector_fk" FOREIGN KEY ("workspace_id", "collector_credential_id") REFERENCES "ingestion_credentials"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "integration_outcome_links" ADD CONSTRAINT "integration_outcome_links_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "integration_outcome_links" ADD CONSTRAINT "integration_link_observation_fk" FOREIGN KEY ("workspace_id", "observation_id") REFERENCES "integration_observations"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "integration_outcome_links" ADD CONSTRAINT "integration_link_outcome_fk" FOREIGN KEY ("workspace_id", "outcome_id") REFERENCES "integration_workflow_outcomes"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "integration_capture_coverage" ADD CONSTRAINT "integration_capture_coverage_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "integration_capture_coverage" ADD CONSTRAINT "integration_coverage_collector_fk" FOREIGN KEY ("workspace_id", "collector_credential_id") REFERENCES "ingestion_credentials"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE UNIQUE INDEX integration_baseline_active_idx ON integration_response_baselines(workspace_id,scope_key) WHERE active;
ALTER TABLE integration_observations ADD CONSTRAINT integration_observation_result_check CHECK (
 (result_kind='HTTP' AND status_code IS NOT NULL AND status_code BETWEEN 200 AND 599) OR (result_kind IN ('TIMEOUT','TRANSPORT','ABORTED') AND status_code IS NULL));
ALTER TABLE integration_observations ADD CONSTRAINT integration_observation_limits_check CHECK (
 attempt BETWEEN 1 AND 1000 AND duration_ms >= 0 AND duration_ms <= 86400000 AND octet_length(envelope::text)<=32768 AND
 processing_state IN ('PENDING','DONE') AND (correlation_kind IS NULL AND correlation_id IS NULL AND correlation_attempt IS NULL OR
 correlation_kind IS NOT NULL AND correlation_kind IN ('workflow','job','trace') AND correlation_id IS NOT NULL AND correlation_attempt IS NOT NULL AND correlation_attempt BETWEEN 1 AND 1000));
ALTER TABLE integration_response_baselines ADD CONSTRAINT integration_baseline_origin_check CHECK (
 version > 0 AND status_code BETWEEN 200 AND 599 AND octet_length(expected_shape::text)<=16384 AND
 (origin='OBSERVED' AND sample_observation_id IS NOT NULL AND api_spec_id IS NULL AND source_sha256 IS NULL OR
 origin='CONTRACT' AND sample_observation_id IS NULL AND api_spec_id IS NOT NULL AND source_sha256 IS NOT NULL AND source_sha256 ~ '^[a-f0-9]{64}$'));
ALTER TABLE integration_workflow_outcomes ADD CONSTRAINT integration_outcome_state_check CHECK (
 outcome IN ('SUCCEEDED','FAILED','CANCELLED') AND correlation_kind IN ('workflow','job','trace') AND correlation_attempt BETWEEN 1 AND 1000 AND
 processing_state IN ('PENDING','DONE') AND octet_length(envelope::text)<=8192);
ALTER TABLE integration_capture_coverage ADD CONSTRAINT integration_coverage_limits_check CHECK (sequence>0 AND octet_length(envelope::text)<=8192);
ALTER TABLE outbox_events ADD CONSTRAINT outbox_integration_target_check CHECK (
 (event_type::text='INTEGRATION_OBSERVATION_REQUESTED' AND integration_observation_id IS NOT NULL AND integration_outcome_id IS NULL AND incident_id IS NULL AND webhook_receipt_id IS NULL AND stripe_webhook_receipt_id IS NULL AND investigation_group_id IS NULL AND evidence_preparation_run_id IS NULL) OR
 (event_type::text='INTEGRATION_OUTCOME_REQUESTED' AND integration_outcome_id IS NOT NULL AND integration_observation_id IS NULL AND incident_id IS NULL AND webhook_receipt_id IS NULL AND stripe_webhook_receipt_id IS NULL AND investigation_group_id IS NULL AND evidence_preparation_run_id IS NULL) OR
 (event_type::text NOT IN ('INTEGRATION_OBSERVATION_REQUESTED','INTEGRATION_OUTCOME_REQUESTED') AND integration_observation_id IS NULL AND integration_outcome_id IS NULL));
CREATE FUNCTION integration_observation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (to_jsonb(NEW)-ARRAY['processing_state','processed_at','detector_evidence','drift_signature','link_truncated']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['processing_state','processed_at','detector_evidence','drift_signature','link_truncated']) THEN
  RAISE EXCEPTION 'Integration acceptance evidence is immutable'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER integration_observation_immutable BEFORE UPDATE ON integration_observations FOR EACH ROW EXECUTE FUNCTION integration_observation_immutable();
CREATE FUNCTION integration_outcome_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (to_jsonb(NEW)-ARRAY['processing_state','processed_at','link_truncated']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['processing_state','processed_at','link_truncated']) THEN RAISE EXCEPTION 'Outcome evidence is immutable'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER integration_outcome_immutable BEFORE UPDATE ON integration_workflow_outcomes FOR EACH ROW EXECUTE FUNCTION integration_outcome_immutable();
CREATE FUNCTION integration_baseline_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (to_jsonb(NEW)-ARRAY['active','activated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['active','activated_at']) THEN
 RAISE EXCEPTION 'Baseline provenance is immutable'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER integration_baseline_immutable BEFORE UPDATE ON integration_response_baselines FOR EACH ROW EXECUTE FUNCTION integration_baseline_immutable();
CREATE FUNCTION integration_coverage_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Coverage snapshots are immutable'; END; $$;
CREATE TRIGGER integration_coverage_immutable BEFORE UPDATE ON integration_capture_coverage FOR EACH ROW EXECUTE FUNCTION integration_coverage_immutable();
CREATE FUNCTION integration_link_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Outcome links are immutable'; END IF;
 PERFORM 1 FROM integration_observations o JOIN integration_workflow_outcomes w ON
  w.workspace_id=o.workspace_id AND w.integration_key=o.integration_key AND w.provider_key=o.provider_key AND w.environment=o.environment AND
  w.correlation_kind=o.correlation_kind AND w.correlation_id=o.correlation_id AND w.correlation_attempt=o.correlation_attempt
 WHERE o.id=NEW.observation_id AND w.id=NEW.outcome_id AND o.workspace_id=NEW.workspace_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Outcome correlation scope mismatch'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER integration_link_scope BEFORE INSERT OR UPDATE ON integration_outcome_links FOR EACH ROW EXECUTE FUNCTION integration_link_scope();
CREATE FUNCTION integration_baseline_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.baseline_id IS NOT NULL THEN
 PERFORM 1 FROM integration_response_baselines WHERE id=NEW.baseline_id AND workspace_id=NEW.workspace_id AND scope_key=NEW.scope_key;
 IF NOT FOUND THEN RAISE EXCEPTION 'Observation baseline scope mismatch'; END IF; END IF; RETURN NEW; END; $$;
CREATE TRIGGER integration_baseline_scope BEFORE INSERT ON integration_observations FOR EACH ROW EXECUTE FUNCTION integration_baseline_scope();
