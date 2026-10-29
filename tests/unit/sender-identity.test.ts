import { describe, expect, it } from "vitest";
import { senderBindingImportSchema, senderReferenceSchema } from "@/lib/ingestion/sender-identity";
import { incidentSubmissionSchema } from "@/lib/validation/incident-envelope";
const uuid = "d6ed8a43-6830-43ae-88d9-674ad3a83bf7";
describe("nonsecret sender aliases and strict claims", () => {
  it("normalizes UUID casing and rejects extra trust assertions or raw key strings", () => {
    expect(senderReferenceSchema.parse({ principalRef: uuid.toUpperCase(), principalKind: "api_key_id" })).toEqual({ principalRef: uuid, principalKind: "api_key_id" });
    for (const value of [{ principalRef: "Bearer synthetic-secret", principalKind: "api_key_id" },
      { principalRef: uuid, principalKind: "api_key" }, { principalRef: uuid, principalKind: "client_id", verified: true }])
      expect(senderReferenceSchema.safeParse(value).success).toBe(false);
  });
  it("rejects forged workspace, credential and canonical identity on an incident", () => {
    const base = { source: "WEBHOOK", sourceEventId: "synthetic", apiKey: "payments", httpMethod: "POST", requestPath: "/payments",
      statusCode: 400, occurredAt: "2025-01-01T00:00:00.000Z", senderReference: { principalKind: "client_id", principalRef: uuid } };
    expect(incidentSubmissionSchema.safeParse(base).success).toBe(true);
    for (const patch of [{ workspaceId: uuid }, { senderId: uuid }, { collectorCredentialId: uuid }, { senderProvenance: { assurance: "verified" } }])
      expect(incidentSubmissionSchema.safeParse({ ...base, ...patch }).success).toBe(false);
  });
  it("requires exact complete registration scope", () => {
    const valid = { ingestionCredentialId: uuid, apiKey: "payments", environment: "default", principalKind: "client_id", principalRef: uuid,
      senderKey: uuid, displayName: "Synthetic checkout" };
    expect(senderBindingImportSchema.safeParse(valid).success).toBe(true);
    for (const patch of [{ apiKey: "*" }, { environment: "*" }, { displayName: "person@example.test" }, { principalRef: "secret" },
      { senderKey: undefined }, { originalAuthenticationVerifiedBySpekTrace: true }])
      expect(senderBindingImportSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});
