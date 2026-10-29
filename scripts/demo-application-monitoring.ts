/**
 * Synthetic application monitoring demo: one HTTP 4xx → SpekTrace ingestion.
 * Requires SPEKTRACE_INGESTION_API_TOKEN and a running app (SPEKTRACE_DEMO_BASE_URL).
 * Does not enable AI investigation or proposal features.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { forwardApplicationHttpFailure } from "@/lib/ingestion/application-monitoring";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function main() {
  const baseUrl = process.env.SPEKTRACE_DEMO_BASE_URL ?? "http://127.0.0.1:3000";
  const token = requireEnv("SPEKTRACE_INGESTION_API_TOKEN");
  const eventId = `appmon-demo-${randomUUID()}`;

  const result = await forwardApplicationHttpFailure(
    { baseUrl, bearerToken: token },
    { apiKey: "payments-api", environment: "default" },
    {
      sourceEventId: eventId,
      httpMethod: "POST",
      requestPath: "/payments",
      statusCode: 400,
      occurredAt: new Date().toISOString(),
      sanitizedRequestBody: { amount: "100" },
      clientReference: "synthetic-appmon-demo",
      client: {
        applicationName: "Synthetic Payments API",
        applicationVersion: "demo-1",
        platform: "node",
      },
    },
  );

  if (!result.ok) {
    console.error(`[appmon-demo] failed: ${result.code} — ${result.message}`);
    process.exit(1);
  }

  console.log("[appmon-demo] incident ingested");
  console.log(`[appmon-demo] incidentId=${result.incidentId}`);
  console.log(`[appmon-demo] created=${result.created} deduplicated=${result.deduplicated}`);
  console.log("[appmon-demo] Run the worker to validate and group; AI features remain opt-in.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
