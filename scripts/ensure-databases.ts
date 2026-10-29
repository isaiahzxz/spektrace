import "dotenv/config";
import pg from "pg";
import { parseDatabaseEndpoint } from "../src/lib/database-url";
import { requireDatabaseUrl } from "../src/lib/env";

const TEST_DATABASE_NAME = "spektrace_test";

function adminConnectionUrl(appUrl: string): string {
  const parsed = new URL(appUrl);
  parsed.pathname = "/postgres";
  return parsed.toString();
}

async function databaseExists(client: pg.Client, name: string): Promise<boolean> {
  const result = await client.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [
    name,
  ]);
  return (result.rowCount ?? 0) > 0;
}

async function main() {
  const appUrl = requireDatabaseUrl();
  const dev = parseDatabaseEndpoint(appUrl);

  const client = new pg.Client({ connectionString: adminConnectionUrl(appUrl) });
  await client.connect();

  try {
    const devExists = await databaseExists(client, dev.database);
    console.log(
      `[db:ensure] development database "${dev.database}" on ${dev.host}:${dev.port}: ${
        devExists ? "present" : "missing"
      }`,
    );

    if (!devExists) {
      throw new Error(
        `Development database "${dev.database}" is missing. Start compose and wait for PostgreSQL, or create the database manually.`,
      );
    }

    const testExists = await databaseExists(client, TEST_DATABASE_NAME);
    if (testExists) {
      console.log(
        `[db:ensure] test database "${TEST_DATABASE_NAME}" on ${dev.host}:${dev.port}: already present`,
      );
      return;
    }

    await client.query(`CREATE DATABASE "${TEST_DATABASE_NAME}"`);
    console.log(
      `[db:ensure] created test database "${TEST_DATABASE_NAME}" on ${dev.host}:${dev.port}`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("[db:ensure] failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
