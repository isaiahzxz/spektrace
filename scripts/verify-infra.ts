import "dotenv/config";
import pg from "pg";
import Redis from "ioredis";
import { parseDatabaseEndpoint } from "../src/lib/database-url";
import { requireDatabaseUrl, requireRedisUrl } from "../src/lib/env";

async function verifyPostgres(): Promise<void> {
  const url = requireDatabaseUrl();
  const endpoint = parseDatabaseEndpoint(url);
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    const result = await client.query("SELECT 1 AS ok");
    if (result.rows[0]?.ok !== 1) {
      throw new Error("PostgreSQL health query returned unexpected result");
    }
    console.log(
      `[infra:check] PostgreSQL reachable at ${endpoint.host}:${endpoint.port} (database: ${endpoint.database})`,
    );
  } finally {
    await client.end();
  }
}

async function verifyRedis(): Promise<void> {
  const url = requireRedisUrl();
  const redis = new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 5000,
    lazyConnect: true,
  });
  await redis.connect();
  try {
    const pong = await redis.ping();
    if (pong !== "PONG") {
      throw new Error(`Redis PING returned ${pong}`);
    }

    const policy = await redis.config("GET", "maxmemory-policy");
    const value = policy?.[1];
    console.log(`[infra:check] Redis PING ok (maxmemory-policy=${value ?? "unknown"})`);
    if (value !== "noeviction") {
      throw new Error(
        `Redis maxmemory-policy is "${value}", expected "noeviction" for BullMQ job safety`,
      );
    }
  } finally {
    await redis.quit();
  }
}

async function main() {
  await verifyPostgres();
  await verifyRedis();
  console.log("[infra:check] all checks passed");
}

main().catch((error) => {
  console.error("[infra:check] failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
