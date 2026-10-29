ALTER TYPE "audit_event_type" ADD VALUE 'SENDER_BINDING_REGISTERED';
ALTER TYPE "audit_event_type" ADD VALUE 'SENDER_BINDING_REVOKED';
CREATE UNIQUE INDEX "ingestion_credentials_workspace_id_id_key" ON "ingestion_credentials"("workspace_id", "id");
CREATE TABLE "workspace_senders" (
  "id" UUID PRIMARY KEY, "workspace_id" UUID NOT NULL, "sender_key" UUID NOT NULL,
  "display_name" VARCHAR(64) NOT NULL, "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "workspace_senders_workspace_id_sender_key_key" ON "workspace_senders"("workspace_id", "sender_key");
CREATE UNIQUE INDEX "workspace_senders_workspace_id_id_key" ON "workspace_senders"("workspace_id", "id");
CREATE TABLE "sender_bindings" (
  "id" UUID PRIMARY KEY, "workspace_id" UUID NOT NULL, "ingestion_credential_id" UUID NOT NULL,
  "api_key" TEXT NOT NULL, "environment" TEXT NOT NULL, "principal_kind" TEXT NOT NULL, "principal_ref" UUID NOT NULL,
  "sender_id" UUID NOT NULL, "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "revoked_at" TIMESTAMPTZ(6),
  CONSTRAINT "sender_principal_kind_check" CHECK ("principal_kind" IN ('client_id','api_key_id')),
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY ("workspace_id", "ingestion_credential_id") REFERENCES "ingestion_credentials"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY ("workspace_id", "sender_id") REFERENCES "workspace_senders"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "sender_binding_scope_key" ON "sender_bindings"("workspace_id", "ingestion_credential_id", "api_key", "environment", "principal_kind", "principal_ref");
CREATE UNIQUE INDEX "sender_bindings_workspace_id_id_key" ON "sender_bindings"("workspace_id", "id");
ALTER TABLE "incidents"
  ADD COLUMN "collector_credential_id" UUID,
  ADD COLUMN "sender_id" UUID,
  ADD COLUMN "sender_binding_id" UUID,
  ADD COLUMN "sender_claim" JSONB,
  ADD COLUMN "reported_client_ref" UUID,
  ADD COLUMN "sender_provenance" JSONB,
  ADD CONSTRAINT "incidents_collector_fk" FOREIGN KEY ("workspace_id", "collector_credential_id") REFERENCES "ingestion_credentials"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "incidents_sender_fk" FOREIGN KEY ("workspace_id", "sender_id") REFERENCES "workspace_senders"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "incidents_sender_binding_fk" FOREIGN KEY ("workspace_id", "sender_binding_id") REFERENCES "sender_bindings"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "incidents_workspace_id_sender_id_received_at_idx" ON "incidents"("workspace_id", "sender_id", "received_at");
CREATE FUNCTION protect_sender_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Sender bindings cannot be deleted'; END IF;
  IF (to_jsonb(NEW) - 'revoked_at') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at') OR
    (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'Sender binding target and revocation are immutable';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER immutable_sender_binding BEFORE UPDATE OR DELETE ON "sender_bindings" FOR EACH ROW EXECUTE FUNCTION protect_sender_binding();
CREATE FUNCTION protect_workspace_sender() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Sender registry records are immutable'; END; $$;
CREATE TRIGGER immutable_workspace_sender BEFORE UPDATE OR DELETE ON "workspace_senders" FOR EACH ROW EXECUTE FUNCTION protect_workspace_sender();
CREATE FUNCTION protect_incident_sender_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.sender_provenance IS NOT NULL AND
    (NEW.sender_id IS DISTINCT FROM OLD.sender_id OR NEW.sender_binding_id IS DISTINCT FROM OLD.sender_binding_id OR
     NEW.collector_credential_id IS DISTINCT FROM OLD.collector_credential_id OR NEW.sender_claim IS DISTINCT FROM OLD.sender_claim OR
     NEW.reported_client_ref IS DISTINCT FROM OLD.reported_client_ref OR NEW.sender_provenance IS DISTINCT FROM OLD.sender_provenance) THEN
    RAISE EXCEPTION 'Incident sender snapshot is immutable';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER immutable_incident_sender BEFORE UPDATE ON "incidents" FOR EACH ROW EXECUTE FUNCTION protect_incident_sender_snapshot();
