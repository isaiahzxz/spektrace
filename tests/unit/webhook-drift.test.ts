import { describe, expect, it } from "vitest";
import { webhookDriftFingerprint, webhookGroupingLabel } from "@/lib/ingestion/webhook-drift";

const type = { jsonPointer: "/amount", keyword: "type", schemaPath: "#/properties/amount/type", message: "must be integer", expected: "integer", observedType: "string" };
const required = { jsonPointer: "/", keyword: "required", schemaPath: "#/required", message: "must have amount", missingProperty: "amount", observedType: "object" };
describe("bounded synthetic drift fingerprint", () => {
  it("canonicalizes structural findings without values, messages or order", () => {
    const fingerprint = webhookDriftFingerprint([type, required]);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(webhookDriftFingerprint([required, { ...type, message: "different message" }, type])).toBe(fingerprint);
    expect(webhookDriftFingerprint([type])).not.toBe(webhookDriftFingerprint([{ ...type, observedType: "null" }]));
    expect(webhookDriftFingerprint([type])).not.toBe(webhookDriftFingerprint([required]));
    expect(webhookDriftFingerprint([type])).not.toBe(webhookDriftFingerprint([{ ...type, expected: "number" }]));
  });
  it("abstains on any unknown, excessive or omitted evidence rather than collapsing it", () => {
    for (const findings of [[], [type, { ...type, keyword: "enum", allowedValues: ["private-value"] }], [type, {}],
      [{ ...type, jsonPointer: "/email" }], [{ ...type, observedType: undefined }], [{ ...required, missingProperty: "private-name" }],
      [{ ...type, schemaPath: "#/$defs/unknown/type" }], Array.from({ length: 33 }, () => type)]) expect(webhookDriftFingerprint(findings)).toBeNull();
  });
  it("keeps legacy, pending and excluded states distinct", () => {
    expect(webhookGroupingLabel(null, "MISMATCH")).toBe("Not evaluated by this grouping version");
    expect(webhookGroupingLabel(null, "NOT_RUN")).toBe("Not evaluated · validation pending");
    expect(webhookGroupingLabel("SENDER_UNVERIFIED", "MISMATCH")).toContain("sender unverified");
    expect(webhookGroupingLabel("unknown", "MISMATCH")).toBe("Grouping decision unavailable");
  });
});
