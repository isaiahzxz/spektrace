import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDatabaseEndpoint } from "@/lib/database-url";

describe("parseDatabaseEndpoint", () => {
  it("extracts host and database without exposing credentials", () => {
    const endpoint = parseDatabaseEndpoint(
      "postgresql://user:secret@127.0.0.1:5432/spektrace_test?schema=public",
    );
    expect(endpoint.host).toBe("127.0.0.1");
    expect(endpoint.port).toBe("5432");
    expect(endpoint.database).toBe("spektrace_test");
  });
});

describe("requireTestDatabaseUrl guards", () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
    vi.resetModules();
  });

  it("requires explicit TEST_DATABASE_URL", async () => {
    process.env.DATABASE_URL =
      "postgresql://spektrace:pw@127.0.0.1:5432/spektrace?schema=public";
    delete process.env.TEST_DATABASE_URL;

    const { requireTestDatabaseUrl } = await import("@/lib/env");
    expect(() => requireTestDatabaseUrl()).toThrow(/TEST_DATABASE_URL is required/);
  });

  it("refuses when test and development databases match", async () => {
    const same =
      "postgresql://spektrace:pw@127.0.0.1:5432/spektrace_test?schema=public";
    process.env.DATABASE_URL = same;
    process.env.TEST_DATABASE_URL = same;

    const { requireTestDatabaseUrl } = await import("@/lib/env");
    expect(() => requireTestDatabaseUrl()).toThrow(/same database as DATABASE_URL/);
  });
});
