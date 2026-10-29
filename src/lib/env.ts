import { z } from "zod";
import {
  isRecognizedTestDatabaseName,
  parseDatabaseEndpoint,
} from "@/lib/database-url";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z.string().min(1).optional(),
  TEST_DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).optional(),
});

export type AppEnv = z.infer<typeof envSchema>;

let cached: AppEnv | null = null;

export function getEnv(): AppEnv {
  if (!cached) {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
      throw new Error(`Invalid environment configuration: ${fields}`);
    }
    cached = parsed.data;
  }
  return cached;
}

export function requireDatabaseUrl(): string {
  const url = getEnv().DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required for this operation");
  }
  return url;
}

export function requireRedisUrl(): string {
  const url = getEnv().REDIS_URL;
  if (!url) {
    throw new Error("REDIS_URL is required for this operation");
  }
  return url;
}

export function requireTestDatabaseUrl(): string {
  const testUrl = getEnv().TEST_DATABASE_URL;
  if (!testUrl) {
    throw new Error(
      "TEST_DATABASE_URL is required for integration tests (set it explicitly in .env)",
    );
  }

  const testEndpoint = parseDatabaseEndpoint(testUrl);
  if (!isRecognizedTestDatabaseName(testEndpoint.database)) {
    throw new Error(
      "Integration tests require TEST_DATABASE_URL database name to include `spektrace_test`",
    );
  }

  const devUrl = getEnv().DATABASE_URL;
  if (devUrl) {
    const devEndpoint = parseDatabaseEndpoint(devUrl);
    const sameTarget =
      devEndpoint.host === testEndpoint.host &&
      devEndpoint.port === testEndpoint.port &&
      devEndpoint.database === testEndpoint.database;

    if (sameTarget) {
      throw new Error(
        "Refusing integration tests: TEST_DATABASE_URL targets the same database as DATABASE_URL",
      );
    }
  }

  return testUrl;
}
