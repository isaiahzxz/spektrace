BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE TABLE "webhook_drift_groups" (
  "id" UUID NOT NULL PRIMARY KEY,
  "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE RESTRICT,
  "api_key" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "http_method" TEXT NOT NULL CHECK ("http_method" = 'POST'),
  "operation_path" TEXT NOT NULL,
  "sender_id" UUID NOT NULL,
  "api_spec_id" UUID NOT NULL,
  "source_sha256" TEXT NOT NULL CHECK ("source_sha256" ~ '^[a-f0-9]{64}$'),
  "drift_fingerprint" TEXT NOT NULL CHECK ("drift_fingerprint" ~ '^[a-f0-9]{64}$'),
  "grouping_version" INTEGER NOT NULL CHECK ("grouping_version" = 1),
  "window_start" TIMESTAMPTZ(6) NOT NULL,
  "window_end" TIMESTAMPTZ(6) NOT NULL CHECK ("window_end" = "window_start" + interval '15 minutes'),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("workspace_id", "id"),
  CONSTRAINT "webhook_drift_dimensions_key" UNIQUE ("workspace_id", "api_key", "environment", "operation_path", "sender_id", "api_spec_id", "source_sha256", "drift_fingerprint", "window_start", "grouping_version"),
  FOREIGN KEY ("workspace_id", "sender_id") REFERENCES "workspace_senders"("workspace_id", "id") ON DELETE RESTRICT,
  FOREIGN KEY ("workspace_id", "api_spec_id") REFERENCES "api_specs"("workspace_id", "id") ON DELETE RESTRICT
);
CREATE INDEX "webhook_drift_sender_idx" ON "webhook_drift_groups"("workspace_id", "sender_id", "window_start");
CREATE INDEX "webhook_drift_spec_idx" ON "webhook_drift_groups"("workspace_id", "api_spec_id");
CREATE TABLE "webhook_grouping_decisions" (
  "receipt_id" UUID NOT NULL PRIMARY KEY,
  "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE RESTRICT,
  "group_id" UUID,
  "reason" TEXT NOT NULL CHECK ("reason" IN ('GROUPED', 'NOT_A_MISMATCH', 'SENDER_UNVERIFIED', 'SENDER_PROVENANCE_INVALID', 'REVISION_UNAVAILABLE', 'EVIDENCE_UNSUPPORTED', 'INELIGIBLE_SCOPE')),
  "grouping_version" INTEGER NOT NULL CHECK ("grouping_version" = 1),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "webhook_grouping_reason_check" CHECK (("reason" = 'GROUPED') = ("group_id" IS NOT NULL)),
  UNIQUE ("workspace_id", "receipt_id"),
  FOREIGN KEY ("workspace_id", "receipt_id") REFERENCES "webhook_receipts"("workspace_id", "id") ON DELETE RESTRICT,
  FOREIGN KEY ("workspace_id", "group_id") REFERENCES "webhook_drift_groups"("workspace_id", "id") ON DELETE RESTRICT
);
CREATE INDEX "webhook_decision_group_idx" ON "webhook_grouping_decisions"("workspace_id", "group_id");
CREATE FUNCTION protect_webhook_grouping() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Webhook grouping records are immutable';
END;
$$;
CREATE TRIGGER webhook_drift_immutable BEFORE UPDATE OR DELETE ON "webhook_drift_groups" FOR EACH ROW EXECUTE FUNCTION protect_webhook_grouping();
CREATE TRIGGER webhook_decision_immutable BEFORE UPDATE OR DELETE ON "webhook_grouping_decisions" FOR EACH ROW EXECUTE FUNCTION protect_webhook_grouping();
COMMIT;
