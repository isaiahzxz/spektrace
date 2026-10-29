import "dotenv/config";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { Client } from "pg";
import { requireDatabaseUrl } from "@/lib/env";
import { deployMigrationsForUrl } from "@/lib/deploy-migrations";

const migration = "20261022030000_sender_revision_grouping";
const tables = ["incidents", "api_specs", "audit_logs", "ingestion_credentials", "deployment_records", "deployment_status_events",
  "contract_revision_intervals", "workspace_senders", "sender_bindings", "investigation_groups", "investigation_group_memberships",
  "evidence_preparation_runs", "investigation_inference_runs", "outbox_events"] as const;
async function main() {
  const url = requireDatabaseUrl(); const endpoint = new URL(url);
  if (!["localhost", "127.0.0.1"].includes(endpoint.hostname) || endpoint.pathname !== "/spektrace") throw new Error("Expected local spektrace");
  if ([process.env.SPEKTRACE_AI_INVESTIGATION_ENABLED, process.env.SPEKTRACE_PAYLOAD_PROPOSALS_ENABLED].some((value) => /^(true|1|on)$/i.test(value ?? "")))
    throw new Error("Disable AI and proposals first");
  const db = new Client({ connectionString: url }); await db.connect();
  try {
    const applied = await db.query<{ migration_name: string }>("SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL");
    if ((await db.query("SELECT 1 FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL")).rowCount) throw new Error("Unfinished migration");
    const pending = (await readdir("prisma/migrations", { withFileTypes: true })).filter((entry) => entry.isDirectory() &&
      !applied.rows.some((row) => row.migration_name === entry.name)).map((entry) => entry.name);
    if (pending.some((name) => name !== migration)) throw new Error("Unexpected pending migration");
    async function snapshot() {
      const result: Record<string, string> = {};
      for (const table of tables) {
        const newFields = table === "investigation_groups" ? " - 'grouping_version' - 'sender_grouping_key' - 'sender_id'" : "";
        const rows = await db.query(`SELECT to_jsonb(t)${newFields} AS row FROM "${table}" t ORDER BY id`);
        result[table] = createHash("sha256").update(JSON.stringify(rows.rows)).digest("hex");
      }
      return JSON.stringify(result);
    }
    const before = await snapshot(); if (pending.length) deployMigrationsForUrl(url);
    if (before !== await snapshot()) throw new Error("Concurrent record change requires review");
    const counts = await db.query("SELECT grouping_version, count(*)::int AS count FROM investigation_groups GROUP BY grouping_version ORDER BY grouping_version");
    console.log(JSON.stringify({ database: "spektrace", migration, appliedNow: pending.length === 1, resetPerformed: false,
      existingRecordsUnchangedExceptLegacyMarkers: true, groupingVersions: counts.rows, automaticRegroupPerformed: false,
      aiEnabled: false, payloadProposalsEnabled: false, restartRequired: true }, null, 2));
  } finally { await db.end(); }
}
main().catch(() => { console.error("Local grouping installation failed or needs review; connection details withheld."); process.exitCode = 1; });
