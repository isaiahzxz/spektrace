import "dotenv/config";
import { randomUUID } from "node:crypto";

const BASE_URL = process.env.SPEKTRACE_DEMO_BASE_URL ?? "http://127.0.0.1:3000";
const TIMEOUT_MS = 30_000;
const POLL_MS = 500;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for the demo`);
  }
  return value;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const token = requireEnv("SPEKTRACE_INTERNAL_API_TOKEN");
  const ingestionToken = requireEnv("SPEKTRACE_INGESTION_API_TOKEN");
  const eventId = `demo-live-${randomUUID()}`;

  const submitResponse = await fetch(`${BASE_URL}/api/internal/incidents`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ingestionToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source: "WEBHOOK",
      sourceEventId: eventId,
      apiKey: "payments-api",
      httpMethod: "POST",
      requestPath: "/payments",
      statusCode: 400,
      occurredAt: new Date().toISOString(),
      sanitizedRequestBody: { amount: 12.5 },
    }),
  });

  if (submitResponse.status !== 202) {
    throw new Error(`Expected HTTP 202, received ${submitResponse.status}`);
  }

  const submitted = (await submitResponse.json()) as { id: string };
  const started = Date.now();

  while (Date.now() - started < TIMEOUT_MS) {
    const getResponse = await fetch(
      `${BASE_URL}/api/internal/incidents/${submitted.id}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    if (!getResponse.ok) {
      throw new Error(`Failed to fetch incident status (${getResponse.status})`);
    }

    const incident = (await getResponse.json()) as {
      validationStatus: string;
      status: string;
      validationEvidence?: { plainEnglishSummary?: string | null };
    };

    if (
      incident.status === "NEEDS_REVIEW" &&
      incident.validationStatus === "MISMATCH"
    ) {
      console.log("[demo] incident processed successfully");
      console.log(`[demo] validationStatus=${incident.validationStatus}`);
      console.log(
        `[demo] explanation=${incident.validationEvidence?.plainEnglishSummary ?? "n/a"}`,
      );
      return;
    }

    await sleep(POLL_MS);
  }

  throw new Error("Timed out waiting for worker validation result");
}

main().catch((error) => {
  console.error(
    "[demo] failed:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
