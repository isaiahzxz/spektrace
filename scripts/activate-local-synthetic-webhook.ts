import "dotenv/config";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { Client } from "pg";
import { requireDatabaseUrl } from "@/lib/env";
import { deployMigrationsForUrl } from "@/lib/deploy-migrations";

const signing = process.argv.includes("--signing");
const grouping = process.argv.includes("--grouping");
const stripe = process.argv.includes("--stripe");
if ([signing, grouping, stripe].filter(Boolean).length > 1) throw new Error("Select one migration mode");
const migration = stripe ? "20261023010000_stripe_test_receipts" : grouping ? "20261022060000_webhook_drift_grouping" : signing ? "20261022050000_synthetic_webhook_signing" : "20261022040000_synthetic_webhook_receipts";
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
      for (const table of [...tables, ...(stripe ? ["webhook_receipts", "webhook_drift_groups", "webhook_grouping_decisions"] : signing || grouping ? ["webhook_receipts"] : [])]) {
        const newFields = stripe && table === "outbox_events" ? " - 'stripe_webhook_receipt_id'" : signing && table === "webhook_receipts" ? " - 'sender_verification'" : !signing && !grouping && table === "outbox_events" ? " - 'webhook_receipt_id'" : "";
        const rows = await db.query(`SELECT to_jsonb(t)${newFields} AS row FROM "${table}" t ORDER BY ${table === "webhook_grouping_decisions" ? "receipt_id" : "id"}`);
        result[table] = createHash("sha256").update(JSON.stringify(rows.rows)).digest("hex");
      }
      return JSON.stringify(result);
    }
    const before = await snapshot(); if (pending.length) deployMigrationsForUrl(url);
    if (before !== await snapshot()) throw new Error("Concurrent record change requires review");
    const counts = await db.query("SELECT count(*)::int AS count FROM webhook_receipts");
    console.log(JSON.stringify({ database: "spektrace", migration, appliedNow: pending.length === 1, resetPerformed: false,
      existingRecordsUnchanged: true, webhookReceiptCount: counts.rows[0].count, fixturesAdded: false,
      aiEnabled: false, payloadProposalsEnabled: false, restartRequired: true }, null, 2));
  } finally { await db.end(); }
}
main().catch((error: unknown) => { const known = ["Expected local spektrace", "Disable AI and proposals first", "Unfinished migration", "Unexpected pending migration", "Concurrent record change requires review"]; const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : error instanceof Error && known.includes(error.message) ? error.message : "UNCLASSIFIED"; console.error(`Safe install diagnostic: ${code}`); console.error("Local synthetic webhook installation failed or needs review; connection details withheld."); process.exitCode = 1; });
