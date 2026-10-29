import { z } from "zod";

export const webhookVerificationSchema = z.object({
  protocol: z.literal("synthetic-hmac-sha256@1"),
  basis: z.literal("configured_signing_key_possession"),
  keyId: z.string().uuid(), senderId: z.string().uuid(), bindingId: z.string().uuid(),
  principalRef: z.string().uuid(), principalKind: z.enum(["client_id", "api_key_id"]),
  verifiedAt: z.string().datetime(), signedAt: z.string().datetime(),
  originalProviderVerified: z.literal(false),
}).strict();
