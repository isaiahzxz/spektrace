import { describe, expect, it } from "vitest";
import { validateJsonSchemaPayload } from "@/lib/validation/validate-json-schema";

const amountSchema = {
  type: "object",
  required: ["amount"],
  properties: {
    amount: { type: "integer" },
  },
} as const;

describe("validateJsonSchemaPayload", () => {
  it("passes integer amount", () => {
    const payload = { amount: 100 };
    const result = validateJsonSchemaPayload(amountSchema, payload);
    expect(result.status).toBe("passed");
    expect(payload).toEqual({ amount: 100 });
  });

  it("reports mismatch for fractional amount without mutating payload", () => {
    const payload = { amount: 12.5 };
    const before = structuredClone(payload);
    const result = validateJsonSchemaPayload(amountSchema, payload);
    expect(result.status).toBe("mismatch");
    if (result.status === "mismatch") {
      expect(result.evidence.length).toBeGreaterThan(0);
      expect(result.evidence[0]?.keyword).toBe("type");
    }
    expect(payload).toEqual(before);
  });

  it("returns unsupported for invalid schema dialect", () => {
    const result = validateJsonSchemaPayload(
      { $schema: "http://json-schema.org/draft-04/schema#", type: "object" },
      {},
    );
    expect(result.status).toBe("unsupported");
  });

  it("records the missing and unexpected field names", () => {
    const strictSchema = {
      type: "object",
      required: ["amount"],
      additionalProperties: false,
      properties: { amount: { type: "integer" } },
    };
    const result = validateJsonSchemaPayload(strictSchema, { note: "x" });
    expect(result.status).toBe("mismatch");
    if (result.status !== "mismatch") return;
    const required = result.evidence.find((e) => e.keyword === "required");
    const extra = result.evidence.find((e) => e.keyword === "additionalProperties");
    expect(required?.missingProperty).toBe("amount");
    expect(extra?.additionalProperty).toBe("note");
  });

  it("resolves observed types for nested paths, not top-level look-alikes", () => {
    const nestedSchema = {
      type: "object",
      properties: {
        order: {
          type: "object",
          properties: { amount: { type: "integer" } },
        },
      },
    };
    const result = validateJsonSchemaPayload(nestedSchema, {
      amount: "top-level string",
      order: { amount: 1.5 },
    });
    expect(result.status).toBe("mismatch");
    if (result.status !== "mismatch") return;
    expect(result.evidence[0]?.jsonPointer).toBe("/order/amount");
    expect(result.evidence[0]?.observedType).toBe("number");
  });

  it("does not treat invalid schema as passed validation", () => {
    const result = validateJsonSchemaPayload({ type: "not-a-real-type" } as Record<
      string,
      unknown
    >, {});
    expect(result.status).not.toBe("passed");
  });
});
