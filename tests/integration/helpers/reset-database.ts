import type { PrismaClient } from "@/generated/prisma/client";
import { deployMigrationsForUrl } from "@/lib/deploy-migrations";
import { parseDatabaseEndpoint } from "@/lib/database-url";
import { requireTestDatabaseUrl } from "@/lib/env";

export function assertDestructiveTestTarget(): void {
  const testUrl = requireTestDatabaseUrl();
  const endpoint = parseDatabaseEndpoint(testUrl);
  if (!endpoint.database.includes("spektrace_test")) {
    throw new Error(
      `Refusing destructive test reset for non-test database "${endpoint.database}"`,
    );
  }
}

export async function resetDatabase(prisma: PrismaClient) {
  assertDestructiveTestTarget();
  const testUrl = requireTestDatabaseUrl();

  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS public CASCADE;`);
  await prisma.$executeRawUnsafe(`CREATE SCHEMA public;`);
  await prisma.$executeRawUnsafe(`GRANT ALL ON SCHEMA public TO public;`);

  deployMigrationsForUrl(testUrl);
}
