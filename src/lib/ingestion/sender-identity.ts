import { z } from "zod";

export const senderUuid = z.string().uuid().transform((value) => value.toLowerCase());
export const principalKindSchema = z.enum(["client_id", "api_key_id"]);
export const senderReferenceSchema = z.object({ principalRef: senderUuid, principalKind: principalKindSchema }).strict();
export const senderBindingImportSchema = z.object({
  ingestionCredentialId: senderUuid,
  apiKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  environment: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  principalRef: senderUuid, principalKind: principalKindSchema, senderKey: senderUuid,
  displayName: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/)
    .refine((value) => !/bearer|authorization|password|secret/i.test(value), "Use a nonsecret sender label"),
}).strict();
export type SenderReference = z.infer<typeof senderReferenceSchema>;
export type SenderBindingImport = z.infer<typeof senderBindingImportSchema>;
