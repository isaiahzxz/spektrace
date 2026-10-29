import { describe, expect, it } from "vitest";
import { aggregateMismatchPatterns } from "@/lib/dashboard/mismatch-patterns";

describe("aggregateMismatchPatterns", () => {
  it("counts each pattern once per incident and keeps specs apart", () => {
    const payments = { id: "spec-a", name: "Payments", version: "v2" };
    const sample = aggregateMismatchPatterns(
      [
        {
          id: "a",
          httpMethod: "POST",
          requestPath: "/payments",
          spec: payments,
          validationEvidence: {
            version: 1,
            findings: [
              { keyword: "type", jsonPointer: "/amount", schemaPath: "#/properties/amount/type", message: "must be integer" },
              { keyword: "type", jsonPointer: "/amount", schemaPath: "#/properties/amount/type", message: "must be integer" },
            ],
          },
        },
        {
          id: "b",
          httpMethod: "POST",
          requestPath: "/payments",
          spec: null,
          validationEvidence: [
            { keyword: "required", jsonPointer: "", schemaPath: "#/required", message: "must have required property 'amount'", missingProperty: "amount" },
          ],
        },
      ],
      2,
    );

    expect(sample.patterns).toHaveLength(2);
    expect(sample.patterns.find((row) => row.rule === "Type")?.specLabel).toBe("Payments v2");
    expect(sample.patterns.find((row) => row.rule === "Type")?.frequency).toBe(1);
    expect(sample.patterns.find((row) => row.rule === "Required field")?.specLabel).toBe("No pinned spec");
  });
});