import { describe, expect, it } from "vitest";
import { parseValidationEvidence } from "@/lib/dashboard/evidence-adapter";

const seedLegacyEvidence = [
  {
    keyword: "type",
    message: "must be integer",
    expected: "integer",
    schemaPath: "#/properties/amount/type",
    jsonPointer: "/amount",
    observedType: "number",
  },
];

const demoV1Evidence = {
  version: 1,
  checkedAt: "2026-10-18T10:00:00.000Z",
  scope: {
    label: "openapi_3_1_inline_request_body",
    openApiVersion: "3.1.0",
    matchedPath: "/v1/payments",
    matchedMethod: "POST",
    covers: "json_request_body_only",
  },
  specRevision: { apiSpecId: "06f5c41a-5911-4250-ae50-92a8af783549", sourceSha256: "abc" },
  validator: { engine: "ajv", schemaDialect: "https://json-schema.org/draft/2020-12/schema" },
  outcome: "mismatch",
  reasonCode: "SCHEMA_MISMATCH",
  reasonMessage: "Request body did not match the schema.",
  plainEnglishSummary: "The amount must be a whole number. The request supplied a decimal.",
  findings: seedLegacyEvidence,
  redactedPaths: ["/card/number"],
};

describe("parseValidationEvidence", () => {
  it("reads the legacy seed array format", () => {
    const parsed = parseValidationEvidence(seedLegacyEvidence);
    expect(parsed.format).toBe("legacy-findings");
    if (parsed.format !== "legacy-findings") return;
    expect(parsed.findings).toEqual([
      expect.objectContaining({
        path: "/amount",
        rule: "Type",
        expected: "integer",
        received: "number",
      }),
    ]);
  });

  it("reads the v1 object format", () => {
    const parsed = parseValidationEvidence(demoV1Evidence);
    expect(parsed.format).toBe("v1");
    if (parsed.format !== "v1") return;
    expect(parsed.plainEnglishSummary).toContain("whole number");
    expect(parsed.scope?.covers).toBe("json_request_body_only");
    expect(parsed.specRevision?.apiSpecId).toBe("06f5c41a-5911-4250-ae50-92a8af783549");
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.redactedPaths).toEqual(["/card/number"]);
  });

  it("returns none for missing evidence and unrecognized for unknown shapes", () => {
    expect(parseValidationEvidence(null).format).toBe("none");
    expect(parseValidationEvidence({ version: 2, findings: [] }).format).toBe("unrecognized");
    expect(parseValidationEvidence("text").format).toBe("unrecognized");
    expect(parseValidationEvidence({ version: 1 }).format).toBe("unrecognized");
  });

  it("counts unreadable findings instead of inventing them", () => {
    const parsed = parseValidationEvidence([{ nonsense: true }, seedLegacyEvidence[0]]);
    expect(parsed.format).toBe("legacy-findings");
    if (parsed.format !== "legacy-findings") return;
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.unreadableFindings).toBe(1);
  });

  it("builds the missing field path from missingProperty or the Ajv message", () => {
    const withParam = parseValidationEvidence([
      { keyword: "required", jsonPointer: "/", schemaPath: "#/required", message: "must have required property 'amount'", missingProperty: "amount" },
    ]);
    const fromMessage = parseValidationEvidence([
      { keyword: "required", jsonPointer: "/order", schemaPath: "#/required", message: "must have required property 'currency'" },
    ]);
    if (withParam.format !== "legacy-findings" || fromMessage.format !== "legacy-findings") {
      throw new Error("unexpected format");
    }
    expect(withParam.findings[0]).toMatchObject({ path: "/amount", received: "Field is missing", pathNote: null });
    expect(fromMessage.findings[0]).toMatchObject({ path: "/order/currency" });
  });

  it("names the unexpected field only when it was recorded", () => {
    const recorded = parseValidationEvidence([
      { keyword: "additionalProperties", jsonPointer: "/", schemaPath: "#/additionalProperties", message: "must NOT have additional properties", additionalProperty: "note" },
    ]);
    const notRecorded = parseValidationEvidence([
      { keyword: "additionalProperties", jsonPointer: "/", schemaPath: "#/additionalProperties", message: "must NOT have additional properties" },
    ]);
    if (recorded.format !== "legacy-findings" || notRecorded.format !== "legacy-findings") {
      throw new Error("unexpected format");
    }
    expect(recorded.findings[0]?.path).toBe("/note");
    expect(notRecorded.findings[0]?.path).toBe("/");
    expect(notRecorded.findings[0]?.pathNote).toContain("not recorded");
  });

  it("never invents a received value", () => {
    const parsed = parseValidationEvidence([
      { keyword: "enum", jsonPointer: "/currency", schemaPath: "#/properties/currency/enum", message: "must be equal to one of the allowed values", allowedValues: ["usd", "eur"] },
      { keyword: "type", jsonPointer: "/amount", schemaPath: "#/properties/amount/type", message: "must be integer", expected: "integer" },
    ]);
    if (parsed.format !== "legacy-findings") throw new Error("unexpected format");
    expect(parsed.findings[0]).toMatchObject({ expected: 'One of: "usd", "eur"', received: "not recorded" });
    expect(parsed.findings[1]).toMatchObject({ expected: "integer", received: "not recorded" });
  });
});
