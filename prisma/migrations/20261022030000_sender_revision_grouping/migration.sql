BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "investigation_groups"
  ADD COLUMN "grouping_version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "sender_grouping_key" TEXT NOT NULL DEFAULT '__legacy_unspecified__',
  ADD COLUMN "sender_id" UUID,
  ADD CONSTRAINT "investigation_group_sender_fk" FOREIGN KEY ("workspace_id", "sender_id") REFERENCES "workspace_senders"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "grouping_identity_check" CHECK (
    ("grouping_version" = 1 AND "sender_id" IS NULL AND "sender_grouping_key" = '__legacy_unspecified__') OR
    ("grouping_version" = 2 AND (("sender_id" IS NOT NULL AND "sender_grouping_key" = 'sender:' || "sender_id"::text) OR
      ("sender_id" IS NULL AND "sender_grouping_key" LIKE 'unknown:%')))
  );
DROP INDEX "investigation_groups_grouping_dimensions_key";
CREATE UNIQUE INDEX "investigation_groups_grouping_dimensions_key" ON "investigation_groups"
  ("workspace_id", "api_key", "environment", "http_method", "operation_identity", "pinned_api_spec_key", "finding_signature", "window_start", "grouping_version", "sender_grouping_key");
CREATE INDEX "investigation_groups_workspace_id_sender_id_window_start_idx" ON "investigation_groups"("workspace_id", "sender_id", "window_start");
COMMIT;
