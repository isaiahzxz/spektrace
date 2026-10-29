import "server-only";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { stripeProtectedShapeSchema } from "@/lib/ingestion/stripe-shape";
import { stripeApiVersionSchema, stripeCheckState, stripeEventIdSchema, stripeEventTypeSchema, stripeReceiptVerificationSchema,
  stripeScopeUnsupported, stripeValidationEvidenceSchema, type StripeReceiptFilters } from "@/lib/dashboard/stripe-receipts";

const listSelect = {
  id: true, integrationId: true, sourceEventId: true, eventType: true, eventCreatedAt: true, receivedAt: true,
  reportedApiVersion: true, validationStatus: true, validatedAt: true,
  outboxEvents: { where: { eventType: "STRIPE_WEBHOOK_VALIDATION_REQUESTED" }, orderBy: { createdAt: "desc" }, take: 1,
    select: { dispatchStatus: true } },
} satisfies Prisma.StripeWebhookReceiptSelect;
type Selected = Prisma.StripeWebhookReceiptGetPayload<{ select: typeof listSelect }>;
function summarize(row: Selected) {
  return { id: row.id, integrationId: row.integrationId, eventId: stripeEventIdSchema.safeParse(row.sourceEventId).success ? row.sourceEventId : null,
    eventType: stripeEventTypeSchema.safeParse(row.eventType).success ? row.eventType : null,
    reportedApiVersion: stripeApiVersionSchema.safeParse(row.reportedApiVersion).success ? row.reportedApiVersion : null,
    eventCreatedAt: row.eventCreatedAt.toISOString(), receivedAt: row.receivedAt.toISOString(), validatedAt: row.validatedAt?.toISOString() ?? null,
    state: stripeCheckState(row.validationStatus, row.outboxEvents[0]?.dispatchStatus ?? null) };
}
function scope(workspaceId: string, filters: StripeReceiptFilters): Prisma.StripeWebhookReceiptWhereInput {
  return { workspaceId, ...(filters.integrationId ? { integrationId: filters.integrationId } : {}) };
}
export async function listStripeReceipts(db: PrismaClient, workspaceId: string, filters: StripeReceiptFilters) {
  if (stripeScopeUnsupported(filters)) return { rows: [], total: 0, pages: 1, scopeUnsupported: true };
  const where = scope(workspaceId, filters);
  const [rows, total] = await Promise.all([
    db.stripeWebhookReceipt.findMany({ where, select: listSelect, orderBy: [{ receivedAt: "desc" }, { id: "desc" }], take: 20, skip: (filters.page - 1) * 20 }),
    db.stripeWebhookReceipt.count({ where }),
  ]);
  return { rows: rows.map(summarize), total, pages: Math.max(1, Math.ceil(total / 20)), scopeUnsupported: false };
}
export async function loadStripeReceipt(db: PrismaClient, workspaceId: string, receiptId: string, filters: StripeReceiptFilters) {
  if (stripeScopeUnsupported(filters) || !z.string().uuid().safeParse(receiptId).success) return null;
  const row = await db.stripeWebhookReceipt.findFirst({ where: { ...scope(workspaceId, filters), id: receiptId },
    select: { ...listSelect, protectedShape: true, verification: true, validationEvidence: true } });
  if (!row) return null;
  const shape = stripeProtectedShapeSchema.safeParse(row.protectedShape);
  const proof = stripeReceiptVerificationSchema.safeParse(row.verification);
  const evidence = stripeValidationEvidenceSchema.safeParse(row.validationEvidence);
  const verificationValid = proof.success && proof.data.workspaceId === workspaceId && proof.data.integrationId === row.integrationId &&
    proof.data.eventId === row.sourceEventId && proof.data.eventType === row.eventType &&
    proof.data.eventCreatedAt === row.eventCreatedAt.toISOString() && proof.data.reportedApiVersion === row.reportedApiVersion;
  const summary = summarize(row);
  const evidenceValid = row.validationStatus === "UNSUPPORTED" && evidence.success;
  return { ...summary, state: summary.state === "Failed" ? "Failed" as const : !shape.success || !verificationValid ? "Incomplete" as const : summary.state,
    verification: verificationValid ? { verifiedAt: proof.data.verifiedAt, signedAt: new Date(proof.data.signatureTimestamp * 1000).toISOString() } : null,
    fields: shape.success ? (["amount", "currency", "status"] as const).map(name => {
      const field = shape.data.fields[name]; return { name, presence: field.presence, jsonType: field.presence === "present" ? field.jsonType : null };
    }) : null,
    protectionPolicy: shape.success ? shape.data.policy : null,
    checkReason: evidenceValid ? evidence.data.reasonCode : null,
    checkedAt: evidenceValid ? evidence.data.checkedAt : null,
  };
}
export type StripeReceiptSummary = ReturnType<typeof summarize>;
export type StripeReceiptDetail = NonNullable<Awaited<ReturnType<typeof loadStripeReceipt>>>;
