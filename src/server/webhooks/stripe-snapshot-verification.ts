import Stripe from "stripe";
import { z } from "zod";
import { protectStripeShape, type StripeProtectedShape } from "@/lib/ingestion/stripe-shape";

export const STRIPE_SNAPSHOT_LIMITS = Object.freeze({
  bodyBytes: 131_072, headerBytes: 2_048, headerFields: 8, signatures: 5,
  rawHeaderEntries: 128, pastSeconds: 300, futureSeconds: 30,
});
const supportedType = z.enum(["payment_intent.payment_failed", "payment_intent.succeeded"]);
export const stripeTestEndpointConfigSchema = z.object({
  workspaceId: z.string().uuid(), integrationId: z.string().uuid(), mode: z.literal("test"),
  secrets: z.array(z.object({
    id: z.string().uuid(), value: z.string().regex(/^whsec_[A-Za-z0-9_+\/=\-]{32,256}$/),
    expiresAt: z.string().datetime(),
  }).strict()).min(1).max(2),
}).strict();
export type StripeTestEndpointConfig = z.infer<typeof stripeTestEndpointConfigSchema>;
const eventEnvelope = z.object({
  id: z.string().regex(/^evt_[A-Za-z0-9]{1,96}$/), object: z.literal("event"),
  type: z.string().regex(/^[a-z][a-z0-9_.]{0,127}$/),
  created: z.number().int().min(0).max(253_402_300_799), livemode: z.boolean(),
  api_version: z.string().regex(/^\d{4}-\d{2}-\d{2}(?:\.[a-z][a-z0-9_-]{0,31})?$/).nullable().optional(),
  account: z.unknown().optional(), context: z.unknown().optional(),
  data: z.object({ object: z.object({ object: z.literal("payment_intent") }).passthrough() }),
});

export type StripeVerificationCode = "INVALID_CONFIGURATION" | "INVALID_BODY" | "INVALID_HEADERS" |
  "SIGNATURE_INVALID" | "TIMESTAMP_OUT_OF_RANGE" | "SIGNING_KEY_UNAVAILABLE" |
  "INVALID_ENVELOPE" | "UNSUPPORTED_EVENT" | "UNSUPPORTED_SCOPE" | "UNKNOWN_PROOF";
export class StripeVerificationError extends Error {
  constructor(readonly code: StripeVerificationCode) {
    super("Stripe snapshot verification rejected"); this.name = "StripeVerificationError";
  }
}
export interface StripeSnapshotMetadata {
  readonly provider: "stripe";
  readonly format: "snapshot";
  readonly workspaceId: string;
  readonly integrationId: string;
  readonly signingSecretId: string;
  readonly eventId: string;
  readonly eventType: z.infer<typeof supportedType>;
  readonly eventCreatedAt: string;
  readonly reportedApiVersion: string | null;
  readonly livemode: false;
  readonly signatureTimestamp: number;
  readonly verifiedAt: string;
  readonly verificationBasis: "configured_endpoint_secret_possession";
  readonly businessProcessingConfirmed: false;
}
declare const verifiedStripeMetadata: unique symbol;
export type VerifiedStripeSnapshotMetadata = { readonly [verifiedStripeMetadata]: true };
const metadataRegistry = new WeakMap<object, Readonly<StripeSnapshotMetadata>>();
const protectionRegistry = new WeakMap<object, { shape: StripeProtectedShape; expiresAt: number }>();

export function readProtectedStripeSnapshot(proof: unknown): { metadata: Readonly<StripeSnapshotMetadata>; shape: StripeProtectedShape } {
  const metadata = readVerifiedStripeSnapshotMetadata(proof);
  const context = typeof proof === "object" && proof !== null ? protectionRegistry.get(proof) : undefined;
  if (!context) throw new StripeVerificationError("UNKNOWN_PROOF");
  const now = Date.now(), age = Math.floor(now / 1000) - metadata.signatureTimestamp;
  if (!Number.isSafeInteger(now) || now < 0 || age > STRIPE_SNAPSHOT_LIMITS.pastSeconds || age < -STRIPE_SNAPSHOT_LIMITS.futureSeconds)
    throw new StripeVerificationError("TIMESTAMP_OUT_OF_RANGE");
  if (context.expiresAt <= now) throw new StripeVerificationError("SIGNING_KEY_UNAVAILABLE");
  return { metadata, shape: context.shape };
}

export function readVerifiedStripeSnapshotMetadata(proof: unknown): Readonly<StripeSnapshotMetadata> {
  const metadata = typeof proof === "object" && proof !== null ? metadataRegistry.get(proof) : undefined;
  if (!metadata) throw new StripeVerificationError("UNKNOWN_PROOF");
  return metadata;
}

function signatureHeader(rawHeaders: readonly string[]): { value: string; timestamp: number } {
  if (!Array.isArray(rawHeaders) || rawHeaders.length > STRIPE_SNAPSHOT_LIMITS.rawHeaderEntries || rawHeaders.length % 2 ||
    rawHeaders.some((value) => typeof value !== "string" || value.length > 8_192)) throw new StripeVerificationError("INVALID_HEADERS");
  const pairs: readonly string[] = rawHeaders;
  const matches = pairs.filter((_value, index) => index % 2 === 1 && pairs[index - 1].toLowerCase() === "stripe-signature");
  if (matches.length !== 1 || Buffer.byteLength(matches[0], "utf8") > STRIPE_SNAPSHOT_LIMITS.headerBytes)
    throw new StripeVerificationError("INVALID_HEADERS");
  const fields = matches[0].split(",").map((part) => part.trim());
  if (fields.length > STRIPE_SNAPSHOT_LIMITS.headerFields || fields.some((part) => !/^(?:t|v\d{1,2})=[A-Za-z0-9_-]{1,256}$/.test(part)))
    throw new StripeVerificationError("INVALID_HEADERS");
  const times = fields.filter((part) => part.startsWith("t="));
  const signatures = fields.filter((part) => part.startsWith("v1="));
  if (times.length !== 1 || !/^t=[1-9][0-9]{9}$/.test(times[0]) || signatures.length === 0 ||
    signatures.length > STRIPE_SNAPSHOT_LIMITS.signatures || signatures.some((part) => !/^v1=[a-f0-9]{64}$/.test(part)))
    throw new StripeVerificationError("INVALID_HEADERS");
  return { value: fields.join(","), timestamp: Number(times[0].slice(2)) };
}

export function createStripeTestSnapshotVerifier(rawConfig: StripeTestEndpointConfig):
  (rawHeaders: readonly string[], rawBody: Buffer) => VerifiedStripeSnapshotMetadata {
  const parsedConfig = stripeTestEndpointConfigSchema.safeParse(rawConfig);
  if (!parsedConfig.success || new Set(parsedConfig.data.secrets.map((secret) => secret.id)).size !== parsedConfig.data.secrets.length ||
    new Set(parsedConfig.data.secrets.map((secret) => secret.value)).size !== parsedConfig.data.secrets.length)
    throw new StripeVerificationError("INVALID_CONFIGURATION");
  const config = parsedConfig.data;
  return (rawHeaders, rawBody) => {
    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0 || rawBody.length > STRIPE_SNAPSHOT_LIMITS.bodyBytes)
      throw new StripeVerificationError("INVALID_BODY");
    const header = signatureHeader(rawHeaders);
    const now = Date.now();
    if (!Number.isSafeInteger(now) || now < 0 || Math.floor(now / 1000) - header.timestamp > STRIPE_SNAPSHOT_LIMITS.pastSeconds ||
      header.timestamp - Math.floor(now / 1000) > STRIPE_SNAPSHOT_LIMITS.futureSeconds)
      throw new StripeVerificationError("TIMESTAMP_OUT_OF_RANGE");
    const secrets = config.secrets.filter((secret) => Date.parse(secret.expiresAt) > now);
    if (!secrets.length) throw new StripeVerificationError("SIGNING_KEY_UNAVAILABLE");
    let matched: (typeof secrets)[number] | undefined;
    for (const secret of secrets) {
      try {
        // Use the SDK's verification-only API so parsing can stay behind strict UTF-8 checks.
        if (Stripe.webhooks.signature?.verifyHeader(rawBody, header.value, secret.value, STRIPE_SNAPSHOT_LIMITS.pastSeconds, undefined, now)) {
          matched = secret; break;
        }
      } catch { /* SDK exceptions can contain raw input; expose only the fixed rejection below. */ }
    }
    if (!matched) throw new StripeVerificationError("SIGNATURE_INVALID");
    let decoded: unknown;
    try { decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(rawBody)); }
    catch { throw new StripeVerificationError("INVALID_ENVELOPE"); }
    const envelope = eventEnvelope.safeParse(decoded);
    if (!envelope.success) throw new StripeVerificationError("INVALID_ENVELOPE");
    const event = envelope.data;
    if (event.livemode || event.account != null || event.context != null) throw new StripeVerificationError("UNSUPPORTED_SCOPE");
    const type = supportedType.safeParse(event.type);
    if (!type.success) throw new StripeVerificationError("UNSUPPORTED_EVENT");
    const metadata: Readonly<StripeSnapshotMetadata> = Object.freeze({ provider: "stripe", format: "snapshot",
      workspaceId: config.workspaceId, integrationId: config.integrationId, signingSecretId: matched.id,
      eventId: event.id, eventType: type.data, eventCreatedAt: new Date(event.created * 1000).toISOString(),
      reportedApiVersion: event.api_version ?? null, livemode: false, signatureTimestamp: header.timestamp,
      verifiedAt: new Date(now).toISOString(), verificationBasis: "configured_endpoint_secret_possession", businessProcessingConfirmed: false });
    const proof = Object.freeze({}) as VerifiedStripeSnapshotMetadata;
    metadataRegistry.set(proof, metadata);
    protectionRegistry.set(proof, { shape: protectStripeShape(event.data.object), expiresAt: Date.parse(matched.expiresAt) });
    return proof;
  };
}
