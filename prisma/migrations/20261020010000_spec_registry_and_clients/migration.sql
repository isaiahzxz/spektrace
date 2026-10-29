-- Service identity stays api_key. Environment is a separate deployment target.
ALTER TABLE "api_specs" ADD COLUMN "environment" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "api_specs" ADD COLUMN "revision_sequence" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "api_specs" ADD COLUMN "provenance" JSONB;
ALTER TABLE "api_specs" ADD COLUMN "activated_at" TIMESTAMPTZ(6);

UPDATE "api_specs" SET "activated_at" = "created_at" WHERE "is_active" = true AND "activated_at" IS NULL;

WITH ranked AS (
  SELECT "id", row_number() OVER (
    PARTITION BY "workspace_id", "api_key", "environment"
    ORDER BY "created_at", "id"
  ) AS seq
  FROM "api_specs"
)
UPDATE "api_specs" AS spec
SET "revision_sequence" = ranked.seq
FROM ranked
WHERE spec."id" = ranked."id";

DROP INDEX "api_specs_workspace_id_api_key_version_key";
CREATE UNIQUE INDEX "api_specs_workspace_id_api_key_environment_version_key"
  ON "api_specs"("workspace_id", "api_key", "environment", "version");
CREATE UNIQUE INDEX "api_specs_workspace_id_api_key_environment_source_sha256_key"
  ON "api_specs"("workspace_id", "api_key", "environment", "source_sha256");

DROP INDEX "api_specs_one_active_per_api_key_idx";
CREATE UNIQUE INDEX "api_specs_one_active_per_service_env_idx"
  ON "api_specs"("workspace_id", "api_key", "environment")
  WHERE "is_active" = true;

CREATE OR REPLACE FUNCTION api_specs_enforce_immutable_revision()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
      OR NEW.api_key IS DISTINCT FROM OLD.api_key
      OR NEW.environment IS DISTINCT FROM OLD.environment
      OR NEW.name IS DISTINCT FROM OLD.name
      OR NEW.version IS DISTINCT FROM OLD.version
      OR NEW.open_api_version IS DISTINCT FROM OLD.open_api_version
      OR NEW.source_filename IS DISTINCT FROM OLD.source_filename
      OR NEW.source_text IS DISTINCT FROM OLD.source_text
      OR NEW.source_sha256 IS DISTINCT FROM OLD.source_sha256
      OR NEW.parsed_document IS DISTINCT FROM OLD.parsed_document
      OR NEW.revision_sequence IS DISTINCT FROM OLD.revision_sequence
      OR NEW.provenance IS DISTINCT FROM OLD.provenance
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'api_specs revision content is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE "incidents" ADD COLUMN "environment" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "incidents" ADD COLUMN "application_name" TEXT;
ALTER TABLE "incidents" ADD COLUMN "application_version" TEXT;
ALTER TABLE "incidents" ADD COLUMN "platform" TEXT;
ALTER TABLE "incidents" ADD COLUMN "sdk_name" TEXT;
ALTER TABLE "incidents" ADD COLUMN "sdk_version" TEXT;

CREATE INDEX "incidents_workspace_id_api_key_environment_received_at_idx"
  ON "incidents"("workspace_id", "api_key", "environment", "received_at");
