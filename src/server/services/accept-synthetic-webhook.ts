import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { protectedWebhookSchema, type ProtectedWebhook } from "@/lib/ingestion/synthetic-webhook";
import { lockIngestionToken, authenticateIngestionToken } from "@/server/services/ingestion-credentials";
import { getActiveApiSpec } from "@/server/repositories/api-specs";
import { resolveIncidentSender } from "@/server/services/sender-identity";
import { webhookVerificationSchema } from "@/lib/ingestion/webhook-verification";
import { webhookRevisionSelectionSchema } from "@/lib/ingestion/webhook-revision";
import { assertSigningFreshness, signingProofContext, WebhookSignatureError, type VerifiedSyntheticWebhook } from "@/server/webhooks/synthetic-signature";

export class WebhookConflictError extends Error { constructor() { super("Event conflicts with an accepted receipt"); } }
export class WebhookRevisionUnavailableError extends Error { constructor() { super("Configured revision unavailable"); } }

export async function acceptSyntheticWebhook(db: PrismaClient, token: string, eventId: string, protectedBody: ProtectedWebhook, proof?: VerifiedSyntheticWebhook) {
  const id = z.string().uuid().parse(eventId).toLowerCase();
  const input = protectedWebhookSchema.parse(protectedBody);
  const signed = proof ? signingProofContext(proof) : null;
  if (signed && (signed.eventId !== id || JSON.stringify(signed.body) !== JSON.stringify(input))) throw new WebhookSignatureError();
  return db.$transaction(async (tx) => {
    const auth = await lockIngestionToken(tx, token);
    if (signed && (signed.workspaceId !== auth.workspaceId || signed.credentialId !== auth.credentialId)) throw new WebhookSignatureError();
    const lock = JSON.stringify(["synthetic-webhook@1", auth.workspaceId, auth.credentialId, id]);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))::text`;
    const sender = signed ? await resolveIncidentSender(tx, auth.workspaceId, auth.credentialId, "synthetic-webhook-payments", "default",
      { principalRef: signed.principalRef, principalKind: signed.principalKind }) : null;
    if (signed && (!sender?.senderId || !sender.senderBindingId)) throw new WebhookSignatureError();
    const verification = signed && sender ? webhookVerificationSchema.parse({ protocol: "synthetic-hmac-sha256@1",
      basis: "configured_signing_key_possession", keyId: signed.keyId, senderId: sender.senderId, bindingId: sender.senderBindingId,
      principalRef: signed.principalRef, principalKind: signed.principalKind, verifiedAt: new Date().toISOString(),
      signedAt: new Date(signed.timestamp * 1000).toISOString(), originalProviderVerified: false }) : null;
    const existing = await tx.webhookReceipt.findUnique({ where: { workspaceId_collectorCredentialId_sourceEventId: {
      workspaceId: auth.workspaceId, collectorCredentialId: auth.credentialId, sourceEventId: id,
    } } });
    if (existing) {
      if (signed) { await authenticateIngestionToken(tx, token); assertSigningFreshness(signed); }
      const oldVerification = webhookVerificationSchema.safeParse(existing.senderVerification);
      if (verification ? !oldVerification.success || oldVerification.data.senderId !== verification.senderId ||
        oldVerification.data.bindingId !== verification.bindingId || oldVerification.data.principalRef !== verification.principalRef ||
        oldVerification.data.principalKind !== verification.principalKind : existing.senderVerification !== null) throw new WebhookConflictError();
      const oldPin = webhookRevisionSelectionSchema.safeParse(existing.revisionSelection);
      const binding = signed?.revisionBinding;
      if (binding ? !oldPin.success || oldPin.data.version !== "configured-at-acceptance@1" ||
        oldPin.data.apiSpecId !== binding.apiSpecId || oldPin.data.sourceSha256 !== binding.sourceSha256 :
        oldPin.success && oldPin.data.version === "configured-at-acceptance@1") throw new WebhookConflictError();
      const prior = protectedWebhookSchema.safeParse({ payload: existing.sanitizedPayload, protection: existing.protection });
      if (!prior.success || JSON.stringify(prior.data) !== JSON.stringify(input)) throw new WebhookConflictError();
      return { id: existing.id, created: false };
    }
    const binding = signed?.revisionBinding;
    const spec = binding ? await tx.apiSpec.findFirst({ where: { id: binding.apiSpecId, workspaceId: auth.workspaceId,
      apiKey: "synthetic-webhook-payments", environment: "default", sourceSha256: binding.sourceSha256 } }) :
      await getActiveApiSpec(tx, auth.workspaceId, "synthetic-webhook-payments", "default");
    if (binding && !spec) throw new WebhookRevisionUnavailableError();
    if (signed) { await authenticateIngestionToken(tx, token); assertSigningFreshness(signed); }
    const receipt = await tx.webhookReceipt.create({ data: {
      workspaceId: auth.workspaceId, collectorCredentialId: auth.credentialId, sourceEventId: id,
      apiKey: "synthetic-webhook-payments", environment: "default", operationPath: "/payments",
      sanitizedPayload: input.payload, protection: input.protection, apiSpecId: spec?.id,
      ...(verification ? { senderVerification: verification } : {}),
      revisionSelection: { version: binding ? "configured-at-acceptance@1" : "active-at-acceptance@1", runtimeVerified: false,
        apiSpecId: spec?.id ?? null, sourceSha256: spec?.sourceSha256 ?? null },
    } });
    await tx.outboxEvent.create({ data: { workspaceId: auth.workspaceId, webhookReceiptId: receipt.id,
      dedupeKey: `webhook-validation:${receipt.id}`, eventType: "WEBHOOK_VALIDATION_REQUESTED" } });
    return { id: receipt.id, created: true };
  });
}
