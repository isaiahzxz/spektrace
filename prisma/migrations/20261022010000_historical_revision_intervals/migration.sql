ALTER TYPE "audit_event_type" ADD VALUE 'HISTORICAL_BINDING_IMPORTED';
ALTER TABLE "incidents" ADD COLUMN "revision_selection_mode" TEXT, ADD COLUMN "revision_selection" JSONB;
ALTER TABLE "incidents" ADD CONSTRAINT "incident_revision_selection_mode_check"
  CHECK ("revision_selection_mode" IS NULL OR "revision_selection_mode" IN ('active_at_ingestion','historical'));
CREATE TABLE "contract_revision_intervals" (
  "id" UUID PRIMARY KEY, "workspace_id" UUID NOT NULL, "integration_key" TEXT NOT NULL,
  "source_interval_id" TEXT NOT NULL, "source_deployment_id" TEXT NOT NULL, "deployment_record_id" UUID NOT NULL,
  "api_key" TEXT NOT NULL, "environment" TEXT NOT NULL, "api_spec_id" UUID NOT NULL,
  "source_sha256" CHAR(64) NOT NULL, "valid_from" TIMESTAMPTZ(3) NOT NULL, "valid_until" TIMESTAMPTZ(3) NOT NULL,
  "import_digest" CHAR(64) NOT NULL, "imported_by" TEXT NOT NULL, "assertion_kind" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "historical_interval_time_check" CHECK ("valid_until" > "valid_from"),
  CONSTRAINT "historical_interval_authority_check" CHECK ("assertion_kind" = 'operator_asserted_interval'),
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY ("workspace_id", "api_spec_id") REFERENCES "api_specs"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY ("workspace_id", "deployment_record_id") REFERENCES "deployment_records"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "historical_binding_identity_key"
  ON "contract_revision_intervals"("workspace_id", "integration_key", "source_interval_id");
CREATE INDEX "historical_binding_scope_time_idx"
  ON "contract_revision_intervals"("workspace_id", "api_key", "environment", "valid_from", "valid_until");
CREATE FUNCTION protect_contract_revision_interval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Historical bindings are immutable'; END; $$;
CREATE TRIGGER immutable_contract_revision_interval BEFORE UPDATE OR DELETE ON "contract_revision_intervals"
  FOR EACH ROW EXECUTE FUNCTION protect_contract_revision_interval();
CREATE FUNCTION protect_incident_revision_selection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revision_selection_mode IS NOT NULL AND
    (NEW.revision_selection_mode IS DISTINCT FROM OLD.revision_selection_mode OR
     NEW.revision_selection IS DISTINCT FROM OLD.revision_selection OR NEW.api_spec_id IS DISTINCT FROM OLD.api_spec_id) THEN
    RAISE EXCEPTION 'Incident revision selection is immutable';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER immutable_incident_revision_selection BEFORE UPDATE ON "incidents"
  FOR EACH ROW EXECUTE FUNCTION protect_incident_revision_selection();
