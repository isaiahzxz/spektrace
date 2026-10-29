import { z } from "zod";

// This grammar deliberately supports fixtures, not arbitrary partner payloads.
const amount = z.union([z.number().finite().min(-999999).max(999999), z.string().regex(/^(?:-?\d{1,6}(?:\.\d{1,4})?|invalid)$/), z.null()]);
const fixture = z.object({
  amount: amount.optional(),
  email: z.string().max(256).optional(),
  name: z.string().max(256).optional(),
  password: z.string().max(256).optional(),
  cardNumber: z.string().max(256).optional(),
}).strict();
export const protectedWebhookSchema = z.object({
  payload: z.object({ amount: amount.optional() }).strict(),
  protection: z.object({ policy: z.literal("synthetic-payments@1"), omittedFields: z.array(z.enum(["email", "name", "password", "cardNumber"])).max(4) }).strict(),
}).strict();
export type ProtectedWebhook = z.infer<typeof protectedWebhookSchema>;

export function sanitizeSyntheticWebhook(input: unknown): ProtectedWebhook {
  const body = fixture.parse(input);
  return {
    payload: body.amount === undefined ? {} : { amount: body.amount },
    protection: { policy: "synthetic-payments@1", omittedFields:
      (["email", "name", "password", "cardNumber"] as const).filter((field) => body[field] !== undefined) },
  };
}
