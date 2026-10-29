import { z } from "zod";
import type { WebhookFilters } from "@/lib/dashboard/webhook-receipts";

export type StripeReceiptFilters = WebhookFilters & { integrationId?: string };
const token = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export const stripeEventIdSchema = z.string().regex(/^evt_[A-Za-z0-9]{1,96}$/);
export const stripeEventTypeSchema = z.enum(["payment_intent.payment_failed", "payment_intent.succeeded"]);
export const stripeApiVersionSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}(?:\.[a-z][a-z0-9_-]{0,31})?$/);
export function parseStripeReceiptFilters(raw: Record<string, string | string[] | undefined>) {
  return z.object({
    integrationId: z.string().uuid().optional(), environment: token.optional(), service: token.optional(),
    page: z.coerce.number().int().min(1).max(10_000),
  }).safeParse({ integrationId: raw.integration || undefined, environment: raw.env || raw.environment || undefined,
    service: raw.svc || raw.service || undefined, page: Array.isArray(raw.page) ? NaN : raw.page || "1" });
}
export function stripeScopeUnsupported(filters: StripeReceiptFilters) { return Boolean(filters.environment || filters.service); }
export function stripeReceiptHref(filters: StripeReceiptFilters, receiptId?: string) {
  const params = new URLSearchParams();
  if (filters.integrationId) params.set("integration", filters.integrationId);
  if (filters.environment) params.set("env", filters.environment);
  if (filters.service) params.set("svc", filters.service);
  if (filters.page > 1) params.set("page", String(filters.page));
  const route = receiptId ? `/dashboard/webhooks/stripe/${receiptId}` : "/dashboard/webhooks/stripe";
  return params.size ? `${route}?${params}` : route;
}
export type StripeCheckState = "Pending" | "Incomplete" | "Failed";
export function stripeCheckState(validation: string, dispatch: string | null): StripeCheckState {
  if (validation === "ERROR" || validation === "NOT_RUN" && dispatch === "FAILED") return "Failed";
  if (validation === "NOT_RUN" && ["PENDING", "CLAIMED", "PUBLISHED"].includes(dispatch ?? "")) return "Pending";
  return "Incomplete";
}
export const stripeReceiptVerificationSchema = z.object({
  provider: z.literal("stripe"), format: z.literal("snapshot"), workspaceId: z.string().uuid(), integrationId: z.string().uuid(),
  signingSecretId: z.string().uuid(), eventId: stripeEventIdSchema, eventType: stripeEventTypeSchema,
  eventCreatedAt: z.string().datetime(), reportedApiVersion: stripeApiVersionSchema.nullable(), livemode: z.literal(false),
  signatureTimestamp: z.number().int().nonnegative().max(253_402_300_799), verifiedAt: z.string().datetime(),
  verificationBasis: z.literal("configured_endpoint_secret_possession"), businessProcessingConfirmed: z.literal(false),
}).strict();
export const stripeValidationEvidenceSchema = z.object({
  version: z.literal(1), outcome: z.literal("UNSUPPORTED"), scope: z.literal("structural_projection_only"),
  businessProcessingConfirmed: z.literal(false), bodyValuesRetained: z.literal(false), checkedAt: z.string().datetime(),
  reasonCode: z.enum(["STRIPE_CONTRACT_NOT_CONFIGURED", "STRIPE_PROTECTION_UNAVAILABLE"]),
}).strict();
