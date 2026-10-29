-- Stage 4A: read-only repository context snapshots

CREATE TYPE "repository_snapshot_import_status" AS ENUM ('COMPLETE', 'PARTIAL');

ALTER TYPE "audit_event_type" ADD VALUE 'REPOSITORY_SNAPSHOT_IMPORTED';

CREATE TABLE "repository_context_snapshots" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "api_key" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "commit_sha" TEXT NOT NULL,
    "import_digest" TEXT NOT NULL,
    "provenance" JSONB,
    "import_status" "repository_snapshot_import_status" NOT NULL,
    "omission_summary" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repository_context_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "repository_snapshot_files" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "relative_path" TEXT NOT NULL,
    "source_sha256" TEXT NOT NULL,
    "sanitized_text" TEXT NOT NULL,
    "line_count" INTEGER NOT NULL,
    "redaction_count" INTEGER NOT NULL DEFAULT 0,
    "had_omissions" BOOLEAN NOT NULL DEFAULT false,
    "omission_codes" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repository_snapshot_files_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "repository_service_file_mappings" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "api_key" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "http_method" TEXT NOT NULL DEFAULT '*',
    "operation_path" TEXT NOT NULL,
    "relative_file_path" TEXT NOT NULL,
    "match_mode" TEXT NOT NULL,
    "identifier_token" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repository_service_file_mappings_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "investigation_inference_runs"
ADD COLUMN "repository_context_snapshot_id" UUID,
ADD COLUMN "repository_excerpt_refs" JSONB;

CREATE UNIQUE INDEX "repository_context_snapshots_idempotent_key"
ON "repository_context_snapshots"("workspace_id", "repository", "commit_sha", "import_digest");

CREATE UNIQUE INDEX "repository_context_snapshots_workspace_id_id_key"
ON "repository_context_snapshots"("workspace_id", "id");

CREATE INDEX "repository_context_snapshots_workspace_service_idx"
ON "repository_context_snapshots"("workspace_id", "api_key", "environment", "created_at");

CREATE UNIQUE INDEX "repository_snapshot_files_workspace_snapshot_path_key"
ON "repository_snapshot_files"("workspace_id", "snapshot_id", "relative_path");

CREATE UNIQUE INDEX "repository_snapshot_files_workspace_id_id_key"
ON "repository_snapshot_files"("workspace_id", "id");

CREATE UNIQUE INDEX "repository_service_file_mappings_unique_key"
ON "repository_service_file_mappings"(
  "workspace_id",
  "api_key",
  "environment",
  "http_method",
  "operation_path",
  "relative_file_path",
  "match_mode",
  "identifier_token"
);

ALTER TABLE "repository_context_snapshots"
ADD CONSTRAINT "repository_context_snapshots_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "repository_snapshot_files"
ADD CONSTRAINT "repository_snapshot_files_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "repository_snapshot_files"
ADD CONSTRAINT "repository_snapshot_files_workspace_snapshot_fkey"
FOREIGN KEY ("workspace_id", "snapshot_id")
REFERENCES "repository_context_snapshots"("workspace_id", "id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "repository_service_file_mappings"
ADD CONSTRAINT "repository_service_file_mappings_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "investigation_inference_runs"
ADD CONSTRAINT "investigation_inference_runs_repository_snapshot_fkey"
FOREIGN KEY ("workspace_id", "repository_context_snapshot_id")
REFERENCES "repository_context_snapshots"("workspace_id", "id")
ON DELETE RESTRICT ON UPDATE CASCADE;
