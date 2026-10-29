SET lock_timeout = '5s';
SET statement_timeout = '30s';
ALTER TYPE "outbox_event_type" ADD VALUE 'STRIPE_WEBHOOK_VALIDATION_REQUESTED';
CREATE TABLE stripe_webhook_integrations (
 id UUID NOT NULL PRIMARY KEY,
 workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
 ingestion_credential_id UUID NOT NULL,
 mode TEXT NOT NULL DEFAULT 'test' CHECK (mode = 'test'),
 created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 disabled_at TIMESTAMPTZ(6),
 UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,ingestion_credential_id) REFERENCES ingestion_credentials(workspace_id,id) ON DELETE RESTRICT
);
CREATE INDEX stripe_integrations_credential_idx ON stripe_webhook_integrations(workspace_id,ingestion_credential_id);
CREATE TABLE stripe_webhook_receipts (
 id UUID NOT NULL PRIMARY KEY,
 workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
 integration_id UUID NOT NULL,
 collector_credential_id UUID NOT NULL,
 source_event_id VARCHAR(100) NOT NULL CHECK(source_event_id ~ '^evt_[A-Za-z0-9]{1,96}$'),
 event_type VARCHAR(64) NOT NULL CHECK(event_type IN ('payment_intent.payment_failed','payment_intent.succeeded')),
 event_created_at TIMESTAMPTZ(6) NOT NULL,
 reported_api_version VARCHAR(64),
 protected_shape JSONB NOT NULL,
 verification JSONB NOT NULL,
 received_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 validation_status validation_status NOT NULL DEFAULT 'NOT_RUN',
 validation_evidence JSONB,
 validated_at TIMESTAMPTZ(6),
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,integration_id,source_event_id),
 FOREIGN KEY(workspace_id,integration_id) REFERENCES stripe_webhook_integrations(workspace_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,collector_credential_id) REFERENCES ingestion_credentials(workspace_id,id) ON DELETE RESTRICT
);
CREATE INDEX stripe_receipts_received_idx ON stripe_webhook_receipts(workspace_id,received_at);
ALTER TABLE outbox_events ADD COLUMN stripe_webhook_receipt_id UUID;
CREATE INDEX outbox_stripe_receipt_idx ON outbox_events(workspace_id,stripe_webhook_receipt_id);
ALTER TABLE outbox_events ADD CONSTRAINT outbox_stripe_workspace_fk FOREIGN KEY(workspace_id,stripe_webhook_receipt_id)
 REFERENCES stripe_webhook_receipts(workspace_id,id) ON DELETE RESTRICT;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_stripe_target_check CHECK (
 (event_type::text = 'STRIPE_WEBHOOK_VALIDATION_REQUESTED' AND stripe_webhook_receipt_id IS NOT NULL AND webhook_receipt_id IS NULL
  AND incident_id IS NULL AND investigation_group_id IS NULL AND evidence_preparation_run_id IS NULL)
 OR (event_type::text <> 'STRIPE_WEBHOOK_VALIDATION_REQUESTED' AND stripe_webhook_receipt_id IS NULL)
);
CREATE FUNCTION protect_stripe_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW) - ARRAY['validation_status','validation_evidence','validated_at']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['validation_status','validation_evidence','validated_at']) THEN
  RAISE EXCEPTION 'Stripe receipt acceptance evidence is immutable';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER stripe_receipt_immutable BEFORE UPDATE ON stripe_webhook_receipts FOR EACH ROW EXECUTE FUNCTION protect_stripe_receipt();
CREATE FUNCTION protect_stripe_integration() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW) - ARRAY['ingestion_credential_id','disabled_at']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['ingestion_credential_id','disabled_at']) THEN
  RAISE EXCEPTION 'Stripe integration identity is immutable';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER stripe_integration_immutable BEFORE UPDATE ON stripe_webhook_integrations FOR EACH ROW EXECUTE FUNCTION protect_stripe_integration();
