import "dotenv/config";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { requireTestDatabaseUrl } from "@/lib/env";

try {
  const databaseUrl = requireTestDatabaseUrl();
  const result = spawnSync(process.execPath, ["node_modules/next/dist/bin/next", "build", "--webpack"], {
    stdio: "inherit", windowsHide: true,
    env: { ...process.env, NODE_ENV: "production", DATABASE_URL: databaseUrl, SPEKTRACE_NEXT_DIST_DIR: `.next-credentials-build-${randomUUID()}`,
      SPEKTRACE_AI_INVESTIGATION_ENABLED: "false", SPEKTRACE_PAYLOAD_PROPOSALS_ENABLED: "false" },
  });
  process.exitCode = result.status ?? 1;
} catch {
  console.error("Isolated build failed. Connection details withheld.");
  process.exitCode = 1;
}
