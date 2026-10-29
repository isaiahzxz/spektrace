ALTER TYPE "audit_event_type" ADD VALUE 'INGESTION_CREDENTIAL_ISSUED';
ALTER TYPE "audit_event_type" ADD VALUE 'INGESTION_CREDENTIAL_REVOKED';
ALTER TYPE "audit_event_type" ADD VALUE 'INGESTION_CREDENTIAL_ROTATED';

CREATE TABLE "ingestion_credentials" (
  "id" UUID PRIMARY KEY,
  "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "name" VARCHAR(80) NOT NULL,
  "token_sha256" CHAR(64) NOT NULL CHECK ("token_sha256" ~ '^[a-f0-9]{64}$'),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "revoked_at" TIMESTAMPTZ(6),
  CHECK ("expires_at" > "created_at")
);
CREATE INDEX "ingestion_credentials_workspace_id_created_at_idx" ON "ingestion_credentials"("workspace_id", "created_at");
