/**
 * Bounded real-model verification harness (3 cases, max 3 provider attempts).
 *
 * Usage:
 *   npm run verify:real-model-inference -- --config-only
 *   npm run verify:real-model-inference -- --dry-run --ack-reset
 *   npm run verify:real-model-inference -- --ack-reset   (live gateway; requires THESYS_API_KEY)
 *
 * Uses TEST_DATABASE_URL only. Destructive reset requires --ack-reset.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireTestDatabaseUrl } from "@/lib/env";
import {
  assertVerificationDatabaseTarget,
  exitCodeForReport,
  readVerificationConfigStatus,
  runVerificationSuite,
} from "./lib/real-model-verification-harness";
import { resetDatabase } from "../tests/integration/helpers/reset-database";

loadEnv({ quiet: true });
const reportDirectory = path.resolve("work/verification-runs", randomUUID());
mkdirSync(reportDirectory, { recursive: true });
for (const level of ["log", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...values: unknown[]) => {
    appendFileSync(
      path.join(reportDirectory, level === "log" ? "stdout.log" : "stderr.log"),
      values
        .map((value) =>
          typeof value === "string" ? value : JSON.stringify(value),
        )
        .join(" ") + "\n",
    );
    original(...values);
  };
}
function writeReport(report: unknown) {
  writeFileSync(
    path.join(reportDirectory, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.error(
    `Machine-readable verification report: ${path.join(reportDirectory, "report.json")}`,
  );
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

async function main() {
  const configOnly = hasFlag("--config-only");
  const dryRun = hasFlag("--dry-run");
  const ackReset = hasFlag("--ack-reset");

  const status = readVerificationConfigStatus();

  if (configOnly) {
    writeReport({
      ...status,
      destructiveResetPerformed: false,
      note: "Configuration-only; no database access or provider calls.",
    });
    console.log(
      JSON.stringify(
        {
          ...status,
          destructiveResetPerformed: false,
          note: "Configuration-only check; no database access or provider calls.",
        },
        null,
        2,
      ),
    );
    process.exit(status.readyForLiveGateway ? 0 : 2);
  }

  if (!ackReset) {
    writeReport({
      execution: { succeeded: false },
      verificationComplete: false,
      failureCode: "RESET_ACKNOWLEDGMENT_REQUIRED",
    });
    console.error(
      "Refusing to run: verification resets TEST_DATABASE_URL (all rows deleted). Pass --ack-reset to continue.",
    );
    console.error(
      "Use --config-only to check gateway configuration without touching the database.",
    );
    process.exit(2);
  }

  if (!dryRun && !status.readyForLiveGateway) {
    writeReport({
      execution: { succeeded: false },
      verificationComplete: false,
      failureCode: "LIVE_CONFIGURATION_MISSING",
    });
    console.error(
      "Live gateway verification incomplete. Configuration missing:",
    );
    for (const reason of status.reasons) {
      console.error(`  - ${reason}`);
    }
    console.error(
      "\nFounder setup (create and store credentials locally; do not paste into chat):",
    );
    console.error("  1. npx @openuidev/cli@latest generate-api-key");
    console.error("  2. Add THESYS_API_KEY to spektrace/.env");
    console.error("  3. SPEKTRACE_AI_INVESTIGATION_ENABLED=true");
    console.error("  4. SPEKTRACE_AI_INFERENCE_ADAPTER=gateway");
    console.error("  5. Re-run with --ack-reset");
    console.error(
      "\nOr run a safe harness simulation: npm run verify:real-model-inference -- --dry-run --ack-reset",
    );
    process.exit(2);
  }

  const db = assertVerificationDatabaseTarget();
  console.error(
    `WARNING: This will DELETE ALL DATA in the verification database "${db.databaseName}" (TEST_DATABASE_URL).`,
  );

  const prisma = createPrismaClientForUrl(requireTestDatabaseUrl());
  const report = await runVerificationSuite(prisma, {
    mode: dryRun ? "dry-run" : "live-gateway",
    resetDatabase,
  });
  await prisma.$disconnect();

  writeReport(report);
  console.log(JSON.stringify(report, null, 2));
  process.exit(exitCodeForReport(report));
}

main().catch((error) => {
  void error;
  writeReport({
    execution: { succeeded: false },
    verificationComplete: false,
    failureCode: "VERIFICATION_EXECUTION_FAILED",
  });
  console.error(
    "Verification execution failed. Connection and provider details withheld.",
  );
  process.exit(1);
});
