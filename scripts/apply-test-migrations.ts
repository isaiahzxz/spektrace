import "dotenv/config";
import { requireTestDatabaseUrl } from "@/lib/env";
import { deployMigrationsForUrl } from "@/lib/deploy-migrations";

try {
  deployMigrationsForUrl(requireTestDatabaseUrl());
  console.log("Additive migrations applied to the guarded test database. No reset performed.");
} catch {
  console.error("Test migration failed. Connection details withheld.");
  process.exitCode = 1;
}
