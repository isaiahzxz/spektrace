export type DatabaseEndpoint = {
  host: string;
  port: string;
  database: string;
};

export function parseDatabaseEndpoint(connectionUrl: string): DatabaseEndpoint {
  let parsed: URL;
  try {
    parsed = new URL(connectionUrl);
  } catch {
    throw new Error("Invalid database connection URL");
  }

  const database = parsed.pathname.replace(/^\//, "").split("/")[0] ?? "";
  if (!database) {
    throw new Error("Database name is missing from connection URL");
  }

  return {
    host: parsed.hostname,
    port: parsed.port || "5432",
    database,
  };
}

export function isRecognizedTestDatabaseName(database: string): boolean {
  return database.includes("spektrace_test");
}
