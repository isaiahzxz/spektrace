import { z } from "zod";

export const webhookRevisionBindingSchema = z.object({
  apiSpecId: z.string().uuid(), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const webhookRevisionSelectionSchema = z.discriminatedUnion("version", [
  z.object({ version: z.literal("active-at-acceptance@1"), runtimeVerified: z.literal(false),
    apiSpecId: z.string().uuid().nullable(), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict(),
  webhookRevisionBindingSchema.extend({ version: z.literal("configured-at-acceptance@1"), runtimeVerified: z.literal(false) }).strict(),
]);
