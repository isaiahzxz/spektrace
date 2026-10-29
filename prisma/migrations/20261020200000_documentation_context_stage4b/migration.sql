CREATE TYPE "documentation_snapshot_import_status" AS ENUM ('COMPLETE', 'PARTIAL');

ALTER TYPE "audit_event_type" ADD VALUE 'DOCUMENTATION_SNAPSHOT_IMPORTED';

CREATE TABLE "documentation_context_snapshots" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "source_key" TEXT NOT NULL,
    "api_key" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "import_digest" TEXT NOT NULL,
    "import_status" "documentation_snapshot_import_status" NOT NULL,
    "omission_summary" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "documentation_context_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "documentation_snapshot_documents" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "document_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content_sha256" TEXT NOT NULL,
    "content_version" TEXT,
    "source_updated_at" TIMESTAMPTZ(6),
    "sanitized_text" TEXT NOT NULL,
    "line_count" INTEGER NOT NULL,
    "redaction_count" INTEGER NOT NULL DEFAULT 0,
    "had_omissions" BOOLEAN NOT NULL DEFAULT false,
    "omission_codes" JSONB,
    "applicability_kind" TEXT NOT NULL,
    "applicability_api_spec_id" UUID,
    "trusted_source_url" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "documentation_snapshot_documents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "documentation_service_topic_mappings" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "api_key" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "http_method" TEXT NOT NULL DEFAULT '*',
    "operation_path" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "section_heading" TEXT NOT NULL,
    "topic_token" TEXT,
    "match_mode" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "documentation_service_topic_mappings_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "investigation_inference_runs"
ADD COLUMN "documentation_context_snapshot_id" UUID,
ADD COLUMN "documentation_excerpt_refs" JSONB;

CREATE UNIQUE INDEX "documentation_context_snapshots_idempotent_key"
ON "documentation_context_snapshots"("workspace_id", "source_key", "import_digest");

CREATE UNIQUE INDEX "documentation_context_snapshots_workspace_id_id_key"
ON "documentation_context_snapshots"("workspace_id", "id");

CREATE INDEX "documentation_context_snapshots_workspace_service_idx"
ON "documentation_context_snapshots"("workspace_id", "api_key", "environment", "created_at");

CREATE UNIQUE INDEX "documentation_snapshot_documents_workspace_snapshot_doc_key"
ON "documentation_snapshot_documents"("workspace_id", "snapshot_id", "document_id");

CREATE UNIQUE INDEX "documentation_snapshot_documents_workspace_id_id_key"
ON "documentation_snapshot_documents"("workspace_id", "id");

CREATE UNIQUE INDEX "documentation_service_topic_mappings_unique_key"
ON "documentation_service_topic_mappings"(
  "workspace_id", "api_key", "environment", "http_method", "operation_path",
  "document_id", "section_heading", "match_mode", "topic_token"
);

ALTER TABLE "documentation_context_snapshots"
ADD CONSTRAINT "documentation_context_snapshots_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "documentation_snapshot_documents"
ADD CONSTRAINT "documentation_snapshot_documents_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "documentation_snapshot_documents"
ADD CONSTRAINT "documentation_snapshot_documents_workspace_snapshot_fkey"
FOREIGN KEY ("workspace_id", "snapshot_id")
REFERENCES "documentation_context_snapshots"("workspace_id", "id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "documentation_service_topic_mappings"
ADD CONSTRAINT "documentation_service_topic_mappings_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "investigation_inference_runs"
ADD CONSTRAINT "investigation_inference_runs_documentation_snapshot_fkey"
FOREIGN KEY ("workspace_id", "documentation_context_snapshot_id")
REFERENCES "documentation_context_snapshots"("workspace_id", "id")
ON DELETE RESTRICT ON UPDATE CASCADE;
