-- Add a severity assignment event. The new value is not used in this migration.
ALTER TYPE "audit_event_type" ADD VALUE 'PATTERN_SEVERITY_SET';

CREATE TABLE "pattern_severity_assignments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "pattern_key" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "provenance" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pattern_severity_assignments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pattern_severity_assignments_workspace_id_pattern_key_key" ON "pattern_severity_assignments"("workspace_id", "pattern_key");

ALTER TABLE "pattern_severity_assignments" ADD CONSTRAINT "pattern_severity_assignments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "pattern_severity_assignments" ADD CONSTRAINT "pattern_severity_assignments_severity_check" CHECK ("severity" IN ('CRITICAL', 'HIGH', 'LOW', 'UNRATED'));

ALTER TABLE "pattern_severity_assignments" ADD CONSTRAINT "pattern_severity_assignments_provenance_check" CHECK ("provenance" IN ('manual'));
