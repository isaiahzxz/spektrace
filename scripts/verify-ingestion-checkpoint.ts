import "dotenv/config";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Client } from "pg";
import { requireTestDatabaseUrl } from "@/lib/env";
import { deployMigrationsForUrl } from "@/lib/deploy-migrations";
import { createPrismaClientForUrl } from "@/lib/db";

async function main() {
  const guardedUrl = requireTestDatabaseUrl();
  const admin = new Client({ connectionString: guardedUrl });
  await admin.connect();
  const runId = randomUUID().replaceAll("-", "").slice(0, 16);
  try {
    for (const phase of ["tests", "http"] as const) {
      const databaseName = `spektrace_test_credentials_${runId}_${phase}`;
      if (!/^spektrace_test_credentials_[a-f0-9]{16}_(tests|http)$/.test(databaseName)) throw new Error("Invalid isolated target");
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      try {
        const isolated = new URL(guardedUrl); isolated.pathname = `/${databaseName}`;
        deployMigrationsForUrl(isolated.toString());
        const db = createPrismaClientForUrl(isolated.toString());
        try {
          const sentinel = await db.workspace.create({ data: { name: "Untouched synthetic sentinel", slug: `sentinel-${runId}-${phase}` } });
          await db.incident.create({ data: { workspaceId: sentinel.id, apiKey: "sentinel", source: "WEBHOOK", sourceEventId: `sentinel-${runId}`,
            httpMethod: "POST", requestPath: "/synthetic-sentinel", statusCode: 400, occurredAt: new Date(),
            status: "NEEDS_REVIEW", validationStatus: "UNSUPPORTED", sanitizedRequestBody: { synthetic: true } } });
        } finally { await db.$disconnect(); }
        const args = phase === "tests"
          ? ["node_modules/vitest/vitest.mjs", "run", "tests/integration/ingestion-credentials.test.ts", "tests/integration/application-monitoring-adapter.test.ts", "tests/integration/correction-approval-checkpoint.test.ts"]
          : ["node_modules/tsx/dist/cli.mjs", "scripts/verify-application-monitoring.ts"];
        console.log(`Credential checkpoint: isolated ${phase} database; existing databases untouched.`);
        const result = spawnSync(process.execPath, args, { stdio: "inherit", windowsHide: true, timeout: 180_000,
          env: { ...process.env, TEST_DATABASE_URL: isolated.toString(), SPEKTRACE_AI_INVESTIGATION_ENABLED: "false", SPEKTRACE_PAYLOAD_PROPOSALS_ENABLED: "false" } });
        if (result.status !== 0) throw new Error(`Credential checkpoint ${phase} failed`);
      } finally {
        await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      }
    }
  } finally { await admin.end(); }
}

main().catch(() => {
  console.error("Isolated credential checkpoint failed. Connection details withheld; inspect the test output above.");
  process.exitCode = 1;
});
