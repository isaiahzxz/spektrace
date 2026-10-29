import { describe, expect, it } from "vitest";
import { buildApplicationMonitoringEnvelope } from "@/lib/ingestion/application-monitoring/build-envelope";

describe("application monitoring adapter envelope", () => {
  const scope = { apiKey: "payments-api", environment: "default" };

  it("builds a WEBHOOK incident envelope for HTTP 4xx failures", () => {
    const built = buildApplicationMonitoringEnvelope(
      {
        sourceEventId: "evt-1",
        httpMethod: "post",
        requestPath: "/payments",
        statusCode: 400,
        occurredAt: "2026-01-01T00:00:00.000Z",
        sanitizedRequestBody: { amount: "100" },
        client: { applicationName: "Synthetic Payments API", platform: "node" },
      },
      scope,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) {
      return;
    }
    expect(built.envelope.source).toBe("WEBHOOK");
    expect(built.envelope.apiKey).toBe("payments-api");
    expect(built.envelope.statusCode).toBe(400);
    expect(built.envelope.client?.sdkName).toBe("spektrace-appmon-adapter");
  });

  it("rejects non-4xx status codes before ingestion", () => {
    const built = buildApplicationMonitoringEnvelope(
      {
        sourceEventId: "evt-2",
        httpMethod: "GET",
        requestPath: "/health",
        statusCode: 500,
        occurredAt: "2026-01-01T00:00:00.000Z",
      },
      scope,
    );
    expect(built.ok).toBe(false);
    if (built.ok) {
      return;
    }
    expect(built.code).toBe("APPMON_STATUS_OUT_OF_RANGE");
  });
});
