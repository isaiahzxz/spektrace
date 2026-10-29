import "dotenv/config";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { Client } from "pg";
import { requireDatabaseUrl } from "@/lib/env";
import { deployMigrationsForUrl } from "@/lib/deploy-migrations";
async function main() {
  const url = requireDatabaseUrl(),
    target = new URL(url),
    migration = "20261027010000_integration_observability";
  if (
    !["127.0.0.1", "localhost"].includes(target.hostname) ||
    target.pathname !== "/spektrace"
  )
    throw Error("Wrong local target");
  if (
    [
      process.env.SPEKTRACE_AI_INVESTIGATION_ENABLED,
      process.env.SPEKTRACE_PAYLOAD_PROPOSALS_ENABLED,
    ].some((v) => /^(true|1|on)$/i.test(v ?? ""))
  )
    throw Error("Disable AI/proposals");
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const applied = await db.query<{ migration_name: string }>(
      "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL",
    );
    if (
      (
        await db.query(
          "SELECT 1 FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL",
        )
      ).rowCount
    )
      throw Error("Unfinished migration");
    const pending = (
      await readdir("prisma/migrations", { withFileTypes: true })
    )
      .filter(
        (e) =>
          e.isDirectory() &&
          !applied.rows.some((r) => r.migration_name === e.name),
      )
      .map((e) => e.name);
    if (pending.some((name) => name !== migration))
      throw Error("Unexpected pending migration");
    const tables = (
      await db.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT LIKE 'integration_%' AND tablename <> '_prisma_migrations' ORDER BY tablename",
      )
    ).rows;
    async function snapshot() {
      const digests: Record<string, string> = {};
      for (const { tablename } of tables) {
        if (!/^[a-z_]+$/.test(tablename)) throw Error("Unsafe table");
        const omit =
          tablename === "outbox_events"
            ? " - ARRAY['integration_observation_id','integration_outcome_id']"
            : "";
        const rows = await db.query(
          `SELECT (to_jsonb(t)${omit})::text AS row FROM "${tablename}" t ORDER BY (to_jsonb(t)${omit})::text`,
        );
        digests[tablename] = createHash("sha256")
          .update(JSON.stringify(rows.rows))
          .digest("hex");
      }
      return JSON.stringify(digests);
    }
    const before = await snapshot();
    if (pending.length) deployMigrationsForUrl(url);
    if (before !== (await snapshot()))
      throw Error("Record changes require review");
    console.log(
      JSON.stringify({
        database: "spektrace",
        migration,
        appliedNow: pending.length === 1,
        existingTablesCompared: tables.length,
        existingRecordsUnchanged: true,
        resetPerformed: false,
        fixturesAdded: false,
      }),
    );
  } finally {
    await db.end();
  }
}
void main().catch(() => {
  console.error(
    "Local observability migration failed or needs review; connection values withheld",
  );
  process.exitCode = 1;
});
