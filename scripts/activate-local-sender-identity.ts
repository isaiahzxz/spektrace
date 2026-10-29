import "dotenv/config";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { Client } from "pg";
import { requireDatabaseUrl } from "@/lib/env";
import { deployMigrationsForUrl } from "@/lib/deploy-migrations";

const migration = "20261022020000_sender_identity";
const tables = ["incidents", "api_specs", "audit_logs", "ingestion_credentials", "deployment_records", "deployment_status_events",
  "contract_revision_intervals", "investigation_groups", "investigation_group_memberships", "evidence_preparation_runs", "investigation_inference_runs"] as const;
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
        const rows = await db.query(`SELECT to_jsonb(t) - 'collector_credential_id' - 'sender_id' - 'sender_binding_id' - 'sender_claim' - 'reported_client_ref' - 'sender_provenance' AS row FROM "${table}" t ORDER BY id`);
        result[table] = createHash("sha256").update(JSON.stringify(rows.rows)).digest("hex");
      }
      return JSON.stringify(result);
    }
    const before = await snapshot(); if (pending.length) deployMigrationsForUrl(url);
    if (before !== await snapshot()) throw new Error("Concurrent record change requires review");
    const count = await db.query("SELECT count(*)::int AS count FROM sender_bindings");
    console.log(JSON.stringify({ database: "spektrace", migration, appliedNow: pending.length === 1, resetPerformed: false,
      existingRecordsUnchanged: true, senderBindings: count.rows[0].count, aiEnabled: false, payloadProposalsEnabled: false, restartRequired: true }, null, 2));
  } finally { await db.end(); }
}
main().catch(() => { console.error("Local sender installation failed or needs review; connection details withheld."); process.exitCode = 1; });
