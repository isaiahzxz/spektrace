SET lock_timeout = '5s';
SET statement_timeout = '30s';
ALTER TYPE "outbox_event_type" ADD VALUE 'WEBHOOK_VALIDATION_REQUESTED';

CREATE TABLE "webhook_receipts" (
  "id" UUID NOT NULL PRIMARY KEY,
  "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE RESTRICT,
  "collector_credential_id" UUID NOT NULL,
  "source_event_id" UUID NOT NULL,
  "api_key" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "operation_path" TEXT NOT NULL,
  "sanitized_payload" JSONB NOT NULL,
  "protection" JSONB NOT NULL,
  "api_spec_id" UUID,
  "revision_selection" JSONB NOT NULL,
  "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "validation_status" "validation_status" NOT NULL DEFAULT 'NOT_RUN',
  "validation_evidence" JSONB,
  "validated_at" TIMESTAMPTZ(6),
  UNIQUE ("workspace_id", "id"),
  UNIQUE ("workspace_id", "collector_credential_id", "source_event_id"),
  FOREIGN KEY ("workspace_id", "collector_credential_id") REFERENCES "ingestion_credentials"("workspace_id", "id") ON DELETE RESTRICT,
  FOREIGN KEY ("workspace_id", "api_spec_id") REFERENCES "api_specs"("workspace_id", "id") ON DELETE RESTRICT
);
CREATE INDEX "webhook_receipts_workspace_id_received_at_idx" ON "webhook_receipts"("workspace_id", "received_at");
CREATE INDEX "webhook_receipts_workspace_id_api_spec_id_idx" ON "webhook_receipts"("workspace_id", "api_spec_id");
ALTER TABLE "outbox_events" ADD COLUMN "webhook_receipt_id" UUID;
CREATE INDEX "outbox_events_workspace_id_webhook_receipt_id_idx" ON "outbox_events"("workspace_id", "webhook_receipt_id");
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_webhook_workspace_fk" FOREIGN KEY ("workspace_id", "webhook_receipt_id") REFERENCES "webhook_receipts"("workspace_id", "id") ON DELETE RESTRICT;
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_webhook_target_check" CHECK (
  ("event_type"::text = 'WEBHOOK_VALIDATION_REQUESTED' AND "webhook_receipt_id" IS NOT NULL AND "incident_id" IS NULL AND "investigation_group_id" IS NULL AND "evidence_preparation_run_id" IS NULL)
  OR ("event_type"::text <> 'WEBHOOK_VALIDATION_REQUESTED' AND "webhook_receipt_id" IS NULL)
);

CREATE FUNCTION protect_webhook_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['validation_status', 'validation_evidence', 'validated_at']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['validation_status', 'validation_evidence', 'validated_at']) THEN
    RAISE EXCEPTION 'Webhook receipt acceptance evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER webhook_receipt_immutable BEFORE UPDATE ON "webhook_receipts" FOR EACH ROW EXECUTE FUNCTION protect_webhook_receipt();
