import { z } from "zod";

const observation = z.discriminatedUnion("presence", [
  z.object({ presence: z.literal("missing") }).strict(),
  z.object({ presence: z.literal("present"), jsonType: z.enum(["null", "array", "object", "string", "boolean", "integer", "number", "non_finite_number"]) }).strict(),
]);
export const stripeProtectedShapeSchema = z.object({
  policy: z.literal("stripe-payment-intent-shape@1"), allValuesOmitted: z.literal(true),
  fields: z.object({ amount: observation, currency: observation, status: observation }).strict(),
}).strict();
export type StripeProtectedShape = z.infer<typeof stripeProtectedShapeSchema>;

export function protectStripeShape(object: Record<string, unknown>): StripeProtectedShape {
  function observe(key: string): z.infer<typeof observation> {
    if (!Object.hasOwn(object, key)) return Object.freeze({ presence: "missing" });
    const value = object[key];
    const jsonType = value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number" ?
      !Number.isFinite(value) ? "non_finite_number" : Number.isInteger(value) ? "integer" : "number" :
      typeof value === "string" ? "string" : typeof value === "boolean" ? "boolean" : "object";
    return Object.freeze({ presence: "present", jsonType });
  }
  return Object.freeze({ policy: "stripe-payment-intent-shape@1", allValuesOmitted: true,
    fields: Object.freeze({ amount: observe("amount"), currency: observe("currency"), status: observe("status") }) });
}
