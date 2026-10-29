import { describe, expect, it } from "vitest";
import { toIncidentDetailView, type StoredDetail } from "@/lib/dashboard/incident-view-models";

const spec = {
  id: "06f5c41a-5911-4250-ae50-92a8af783549",
  name: "Payments API",
  version: "1.0.0",
  openApiVersion: "3.1.0",
  sourceFilename: "payments.yaml",
  sourceSha256: "a".repeat(64),
  isActive: true,
};

function detail(overrides: Partial<StoredDetail> = {}): StoredDetail {
  return {
    id: "8bc54506-889c-4fac-94bc-97314ef28ff1",
    httpMethod: "POST",
    requestPath: "/v1/payments",
    statusCode: 400,
    status: "NEEDS_REVIEW",
    validationStatus: "MISMATCH",
    validationEvidence: null,
    receivedAt: new Date("2026-10-18T10:00:00Z"),
    apiKey: "payments",
    environment: "default",
    apiSpecId: spec.id,
    source: "WEBHOOK",
    sourceEventId: "evt-1",
    clientReference: null,
    sanitizedRequestBody: { amount: 10.5, card: "[REDACTED]" },
    occurredAt: new Date("2026-10-18T09:59:00Z"),
    validatedAt: new Date("2026-10-18T10:00:01Z"),
    processingErrorCode: null,
    processingErrorMessage: null,
    apiSpec: spec,
    ...overrides,
  };
}

describe("toIncidentDetailView", () => {
  it("uses the stored explanation and never regenerates one", () => {
    const withSummary = toIncidentDetailView(
      detail({ validationEvidence: { version: 1, findings: [], plainEnglishSummary: "Stored text." } }),
      "object",
    );
    expect(withSummary.explanation).toMatchObject({ state: "stored", text: "Stored text." });

    const legacy = toIncidentDetailView(
      detail({ validationEvidence: [{ keyword: "type", jsonPointer: "/amount", schemaPath: "", message: "must be integer" }] }),
      "object",
    );
    expect(legacy.explanation).toMatchObject({
      state: "missing",
      heading: "No explanation was stored for this incident.",
    });
  });

  it("shows honest pending, unsupported and failed explanations", () => {
    expect(
      toIncidentDetailView(detail({ status: "RECEIVED", validationStatus: "NOT_RUN" }), "object").explanation.heading,
    ).toBe("This request is waiting to be checked.");
    expect(
      toIncidentDetailView(detail({ validationStatus: "UNSUPPORTED" }), "object").explanation.heading,
    ).toBe("This check is outside the currently supported rules.");
    expect(
      toIncidentDetailView(detail({ status: "FAILED", validationStatus: "ERROR" }), "object").explanation.heading,
    ).toBe("The check could not finish.");
  });

  it("falls back to the evidence check time when validatedAt was not set", () => {
    const view = toIncidentDetailView(
      detail({
        validatedAt: null,
        validationStatus: "UNSUPPORTED",
        validationEvidence: { version: 1, findings: [], checkedAt: "2026-10-18T10:00:05.000Z" },
      }),
      "object",
    );
    expect(view.checkedAt).toBe("2026-10-18 10:00:05 UTC");
  });

  it("distinguishes a missing body from JSON null and keeps redaction markers", () => {
    expect(toIncidentDetailView(detail({ sanitizedRequestBody: null }), null).body).toEqual({ kind: "missing" });
    expect(toIncidentDetailView(detail({ sanitizedRequestBody: null }), "null").body).toEqual({
      kind: "json",
      text: "null",
      isJsonNull: true,
    });
    const body = toIncidentDetailView(detail(), "object").body;
    expect(body.kind === "json" && body.text).toContain('"[REDACTED]"');
  });

  it("reads the pinned spec from the incident relation and compares the evidence checksum", () => {
    const matching = toIncidentDetailView(
      detail({ validationEvidence: { version: 1, findings: [], specRevision: { apiSpecId: spec.id, sourceSha256: spec.sourceSha256 } } }),
      "object",
    );
    expect(matching.spec).toMatchObject({ kind: "pinned", id: spec.id, evidenceChecksum: "matches" });

    const differs = toIncidentDetailView(
      detail({ validationEvidence: { version: 1, findings: [], specRevision: { apiSpecId: spec.id, sourceSha256: "b".repeat(64) } } }),
      "object",
    );
    expect(differs.spec).toMatchObject({ evidenceChecksum: "differs" });

    const none = toIncidentDetailView(
      detail({
        apiSpecId: null,
        apiSpec: null,
        validationStatus: "UNSUPPORTED",
        validationEvidence: { version: 1, findings: [], reasonCode: "ACTIVE_SPEC_NOT_FOUND" },
      }),
      "object",
    );
    expect(none.spec.kind).toBe("none");
    expect(none.spec.kind === "none" && none.spec.reason).toContain("No active API specification");
  });
});
