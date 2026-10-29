import "dotenv/config";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { Client } from "pg";
import { requireDatabaseUrl } from "@/lib/env";
import { deployMigrationsForUrl } from "@/lib/deploy-migrations";

const migration = "20261022010000_historical_revision_intervals";
const tables = ["incidents", "api_specs", "audit_logs", "ingestion_credentials", "deployment_records", "deployment_status_events",
  "investigation_groups", "investigation_group_memberships", "evidence_preparation_runs", "investigation_inference_runs"] as const;

async function main() {
  const url = requireDatabaseUrl(); const endpoint = new URL(url);
  if (!["localhost", "127.0.0.1"].includes(endpoint.hostname) || endpoint.pathname !== "/spektrace")
    throw new Error("Expected local spektrace database");
  if ([process.env.SPEKTRACE_AI_INVESTIGATION_ENABLED, process.env.SPEKTRACE_PAYLOAD_PROPOSALS_ENABLED].some((value) => /^(true|1|on)$/i.test(value ?? "")))
    throw new Error("Disable AI and proposals before local activation");
  const db = new Client({ connectionString: url }); await db.connect();
  try {
    const applied = await db.query<{ migration_name: string }>("SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL");
    const failed = await db.query("SELECT 1 FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL");
    if (failed.rowCount) throw new Error("Unfinished migration requires operator review");
    const directories = await readdir("prisma/migrations", { withFileTypes: true });
    const pending = directories.filter((entry) => entry.isDirectory() && !applied.rows.some((row) => row.migration_name === entry.name)).map((entry) => entry.name);
    if (pending.some((name) => name !== migration)) throw new Error("Unexpected pending migration");
    async function snapshot() {
      const result: Record<string, { rows: number; digest: string }> = {};
      for (const table of tables) {
        const rows = await db.query(`SELECT to_jsonb(t) - 'revision_selection_mode' - 'revision_selection' AS row FROM "${table}" AS t ORDER BY id`);
        result[table] = { rows: rows.rowCount ?? 0, digest: createHash("sha256").update(JSON.stringify(rows.rows)).digest("hex") };
      }
      return result;
    }
    const before = await snapshot();
    if (pending.length) deployMigrationsForUrl(url);
    const after = await snapshot();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Concurrent data change detected; inspect before claiming preservation");
    const bindings = await db.query("SELECT count(*)::int AS count FROM contract_revision_intervals");
    console.log(JSON.stringify({ database: "spektrace", migration, appliedNow: pending.length === 1,
      resetPerformed: false, existingRecordsUnchanged: true, historicalBindings: bindings.rows[0].count,
      aiEnabled: false, payloadProposalsEnabled: false, restartRequired: true }, null, 2));
  } finally { await db.end(); }
}
main().catch(() => { console.error("Local historical activation failed or needs review; connection details withheld."); process.exitCode = 1; });
