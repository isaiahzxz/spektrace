import { isDeepStrictEqual } from "node:util";
import type { PrismaClient } from "@/generated/prisma/client";
import { lockIngestionToken, authenticateIngestionToken, IngestionUnauthorizedError } from "@/server/services/ingestion-credentials";
import { readProtectedStripeSnapshot } from "@/server/webhooks/stripe-snapshot-verification";

export class StripeReceiptConflictError extends Error { constructor() { super("Stripe event conflicts with its retained receipt"); } }
export async function acceptStripeWebhook(db: PrismaClient, serverToken: string, proof: unknown) {
  const initial = readProtectedStripeSnapshot(proof);
  return db.$transaction(async (tx) => {
    const auth = await lockIngestionToken(tx, serverToken);
    const m = initial.metadata;
    if (auth.workspaceId !== m.workspaceId) throw new IngestionUnauthorizedError();
    await tx.$queryRaw`SELECT id FROM stripe_webhook_integrations WHERE workspace_id=${auth.workspaceId}::uuid AND id=${m.integrationId}::uuid FOR SHARE`;
    const integration = await tx.stripeWebhookIntegration.findFirst({ where: { id: m.integrationId, workspaceId: auth.workspaceId,
      ingestionCredentialId: auth.credentialId, mode: "test", disabledAt: null } });
    if (!integration) throw new IngestionUnauthorizedError();
    const lock = JSON.stringify(["stripe-receipt@1", auth.workspaceId, m.integrationId, m.eventId]);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock},0))::text`;
    await authenticateIngestionToken(tx, serverToken);
    const { metadata, shape } = readProtectedStripeSnapshot(proof);
    const existing = await tx.stripeWebhookReceipt.findUnique({ where: { workspaceId_integrationId_sourceEventId: {
      workspaceId: auth.workspaceId, integrationId: integration.id, sourceEventId: metadata.eventId } } });
    if (existing) {
      if (existing.eventType !== metadata.eventType || existing.eventCreatedAt.toISOString() !== metadata.eventCreatedAt ||
        existing.reportedApiVersion !== metadata.reportedApiVersion || !isDeepStrictEqual(existing.protectedShape, shape))
        throw new StripeReceiptConflictError();
      return { id: existing.id, created: false };
    }
    const receipt = await tx.stripeWebhookReceipt.create({ data: { workspaceId: auth.workspaceId, integrationId: integration.id,
      collectorCredentialId: auth.credentialId, sourceEventId: metadata.eventId, eventType: metadata.eventType,
      eventCreatedAt: new Date(metadata.eventCreatedAt), reportedApiVersion: metadata.reportedApiVersion,
      protectedShape: shape, verification: { ...metadata } } });
    await tx.outboxEvent.create({ data: { workspaceId: auth.workspaceId, stripeWebhookReceiptId: receipt.id,
      eventType: "STRIPE_WEBHOOK_VALIDATION_REQUESTED", dedupeKey: `stripe-validation:${receipt.id}` } });
    return { id: receipt.id, created: true };
  });
}
