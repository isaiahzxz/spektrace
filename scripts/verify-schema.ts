import "dotenv/config";
import pg from "pg";
import { parseDatabaseEndpoint } from "../src/lib/database-url";
import { requireDatabaseUrl } from "../src/lib/env";

type Row = Record<string, unknown>;

async function main() {
  const url = requireDatabaseUrl();
  const endpoint = parseDatabaseEndpoint(url);
  const client = new pg.Client({ connectionString: url });
  await client.connect();

  try {
    const tables = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    const names = tables.rows.map((r) => r.tablename);
    const expected = ["api_specs", "audit_logs", "incidents", "workspaces"];
    for (const table of expected) {
      if (!names.includes(table)) {
        throw new Error(`Missing table: ${table}`);
      }
    }
    console.log(`[db:verify-schema] tables present on ${endpoint.database}: ${names.join(", ")}`);

    const migrations = await client.query(
      `SELECT migration_name, finished_at IS NOT NULL AS applied
       FROM _prisma_migrations
       ORDER BY migration_name`,
    );
    if ((migrations.rowCount ?? 0) === 0) {
      throw new Error("No rows in _prisma_migrations — run npm run db:migrate:deploy");
    }
    const pending = migrations.rows.filter((r: Row) => !r.applied);
    if (pending.length > 0) {
      throw new Error(`Pending migrations: ${pending.map((r: Row) => r.migration_name).join(", ")}`);
    }
    console.log(
      `[db:verify-schema] Prisma migrations applied: ${migrations.rows
        .map((r: Row) => r.migration_name)
        .join(", ")}`,
    );

    const statusCheck = await client.query(
      `SELECT conname FROM pg_constraint WHERE conname = 'incidents_status_code_4xx_check'`,
    );
    if ((statusCheck.rowCount ?? 0) !== 1) {
      throw new Error("Missing incidents_status_code_4xx_check constraint");
    }

    const partialIndex = await client.query(
      `SELECT indexname FROM pg_indexes WHERE indexname = 'api_specs_one_active_per_api_key_idx'`,
    );
    if ((partialIndex.rowCount ?? 0) !== 1) {
      throw new Error("Missing api_specs_one_active_per_api_key_idx partial unique index");
    }

    const immutabilityTrigger = await client.query(
      `SELECT tgname FROM pg_trigger WHERE tgname = 'api_specs_immutable_revision_trigger'`,
    );
    if ((immutabilityTrigger.rowCount ?? 0) !== 1) {
      throw new Error("Missing api_specs_immutable_revision_trigger");
    }

    for (const tg of [
      "audit_logs_deny_update_trigger",
      "audit_logs_deny_delete_trigger",
      "audit_logs_deny_truncate_trigger",
    ]) {
      const res = await client.query(`SELECT tgname FROM pg_trigger WHERE tgname = $1`, [tg]);
      if ((res.rowCount ?? 0) !== 1) {
        throw new Error(`Missing trigger: ${tg}`);
      }
    }

    const compoundFks = await client.query(
      `SELECT conname FROM pg_constraint
       WHERE conname IN ('incidents_workspace_id_api_spec_id_fkey', 'audit_logs_workspace_id_incident_id_fkey')`,
    );
    if ((compoundFks.rowCount ?? 0) !== 2) {
      throw new Error("Missing expected tenant compound foreign keys");
    }

    console.log("[db:verify-schema] constraints, indexes, and triggers verified");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("[db:verify-schema] failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
