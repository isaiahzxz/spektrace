import { describe, expect, it } from "vitest";
import { protectStripeShape, stripeProtectedShapeSchema } from "@/lib/ingestion/stripe-shape";

describe("value-free Stripe structural projection", () => {
  it("exports only fixed field presence/types, never nested values or customer keys", () => {
    const shape = protectStripeShape({ amount: "4242424242424242", currency: "private@example.test", status: { password: "secret" }, customer: "private" });
    expect(shape.fields).toEqual({ amount: { presence: "present", jsonType: "string" }, currency: { presence: "present", jsonType: "string" }, status: { presence: "present", jsonType: "object" } });
    expect(stripeProtectedShapeSchema.safeParse(shape).success).toBe(true);
    for (const marker of ["424242", "private", "secret", "customer"]) expect(JSON.stringify(shape)).not.toContain(marker);
  });
  it("preserves missing, null, array and numeric types and freezes all nested observations", () => {
    const missing = protectStripeShape({}); expect(missing.fields.amount).toEqual({ presence: "missing" });
    expect(Object.isFrozen(missing.fields.amount)).toBe(true); expect(Object.isFrozen(missing.fields)).toBe(true);
    expect(() => { (missing.fields.amount as { presence: string }).presence = "present"; }).toThrow();
    expect(protectStripeShape({ amount: 10, currency: null, status: [] }).fields).toEqual({ amount: { presence: "present", jsonType: "integer" }, currency: { presence: "present", jsonType: "null" }, status: { presence: "present", jsonType: "array" } });
    expect(protectStripeShape({ amount: 1.5 }).fields.amount).toMatchObject({ jsonType: "number" });
    expect(protectStripeShape({ amount: Infinity }).fields.amount).toMatchObject({ jsonType: "non_finite_number" });
  });
});
