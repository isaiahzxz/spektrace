import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { sanitizeSyntheticWebhook, type ProtectedWebhook } from "@/lib/ingestion/synthetic-webhook";
import { webhookRevisionBindingSchema } from "@/lib/ingestion/webhook-revision";

export const SIGNED_WEBHOOK_PATH = "/synthetic/signed-webhooks/payments";
const uuid = z.string().uuid().regex(/^[a-f0-9-]{36}$/);
const keySchema = z.object({ keyId: uuid, workspaceId: uuid, credentialId: uuid,
  principalRef: uuid, principalKind: z.enum(["client_id", "api_key_id"]),
  secretHex: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.string().datetime(),
  revisionBinding: webhookRevisionBindingSchema.optional(),
}).strict();
export type SyntheticSigningKey = z.infer<typeof keySchema>;
export class WebhookSignatureError extends Error { constructor() { super("Synthetic signature verification failed"); } }
export class WebhookPayloadError extends Error { constructor() { super("Payload is outside the synthetic allowlist"); } }
type ProofContext = Omit<SyntheticSigningKey, "secretHex"> & { timestamp: number; eventId: string; body: ProtectedWebhook };
const contexts = new WeakMap<object, ProofContext>();
declare const verified: unique symbol;
export type VerifiedSyntheticWebhook = { readonly [verified]: true };

export function singleWebhookHeader(rawHeaders: string[], name: string) {
  const values = rawHeaders.filter((_value, index, all) => index % 2 === 1 && all[index - 1].toLowerCase() === name);
  return values.length === 1 ? values[0] : null;
}
export function assertSigningFreshness(context: Pick<ProofContext, "timestamp" | "expiresAt">) {
  const now = Date.now(); const age = now - context.timestamp * 1000;
  if (age > 300_000 || age < -30_000 || Date.parse(context.expiresAt) <= now) throw new WebhookSignatureError();
}
export function signingProofContext(proof: VerifiedSyntheticWebhook) {
  const context = contexts.get(proof);
  if (!context) throw new WebhookSignatureError();
  return context;
}
export function createSyntheticSignatureVerifier(rawKeys: SyntheticSigningKey[]) {
  const parsed = z.array(keySchema).min(1).max(20).safeParse(rawKeys);
  if (!parsed.success) throw new Error("Invalid synthetic signing configuration; values withheld");
  const keys = parsed.data;
  if (new Set(keys.map((key) => key.keyId)).size !== keys.length || new Set(keys.map((key) => key.secretHex)).size !== keys.length)
    throw new Error("Synthetic signing keys must have distinct ids and secrets");
  return (rawHeaders: string[], rawBody: Buffer, method: string, target: string): VerifiedSyntheticWebhook => {
    const keyId = singleWebhookHeader(rawHeaders, "x-spek-key-id");
    const eventId = singleWebhookHeader(rawHeaders, "x-spek-event-id");
    const timestamp = singleWebhookHeader(rawHeaders, "x-spek-timestamp");
    const signature = singleWebhookHeader(rawHeaders, "x-spek-signature");
    const key = keys.find((candidate) => candidate.keyId === keyId);
    if (!key || !eventId || !uuid.safeParse(eventId).success || !timestamp || !/^[1-9][0-9]{9}$/.test(timestamp) ||
      !signature || !/^v1=[a-f0-9]{64}$/.test(signature) || method !== "POST" || target !== SIGNED_WEBHOOK_PATH ||
      !Buffer.isBuffer(rawBody) || rawBody.length === 0 || rawBody.length > 4096) throw new WebhookSignatureError();
    assertSigningFreshness({ timestamp: Number(timestamp), expiresAt: key.expiresAt });
    const prefix = ["synthetic-hmac-sha256@1", "POST", SIGNED_WEBHOOK_PATH, key.keyId, key.workspaceId, key.credentialId,
      key.principalKind, key.principalRef, eventId, timestamp, ""].join("\n");
    const expected = createHmac("sha256", Buffer.from(key.secretHex, "hex")).update(prefix).update(rawBody).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature.slice(3), "hex"))) throw new WebhookSignatureError();
    let body: ProtectedWebhook;
    try { body = sanitizeSyntheticWebhook(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody))); }
    catch { throw new WebhookPayloadError(); }
    Object.freeze(body.payload); Object.freeze(body.protection.omittedFields); Object.freeze(body.protection); Object.freeze(body);
    const proof = Object.freeze({}) as VerifiedSyntheticWebhook;
    // Keep only the protected projection in the capability, never the original bytes or signature.
    const { secretHex: _secret, ...metadata } = key; void _secret;
    if (metadata.revisionBinding) Object.freeze(metadata.revisionBinding);
    contexts.set(proof, Object.freeze({ ...metadata, eventId, timestamp: Number(timestamp), body }));
    return proof;
  };
}
