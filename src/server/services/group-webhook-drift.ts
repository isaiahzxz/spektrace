import { z } from "zod";
import type { Prisma, WebhookReceipt } from "@/generated/prisma/client";
import { webhookVerificationSchema } from "@/lib/ingestion/webhook-verification";
import { webhookDriftFingerprint, WEBHOOK_GROUPING_VERSION, type WebhookGroupingReason } from "@/lib/ingestion/webhook-drift";
import { groupingWindowForReceivedAt } from "@/lib/investigation/grouping-window";
import { protectedWebhookSchema } from "@/lib/ingestion/synthetic-webhook";
import { webhookRevisionSelectionSchema } from "@/lib/ingestion/webhook-revision";

const evidenceSchema = z.object({ version: z.literal(1), outcome: z.literal("MISMATCH"),
  scope: z.object({ matchedMethod: z.literal("POST"), matchedPath: z.literal("/payments"), covers: z.literal("json_request_body_only") }),
  specRevision: z.object({ apiSpecId: z.string().uuid(), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  findings: z.array(z.unknown()).min(1).max(32), redactedPaths: z.array(z.string()).length(0),
});

// Called only under the receipt FOR UPDATE lock, inside its validation transaction.
export async function recordWebhookGrouping(tx: Prisma.TransactionClient, row: WebhookReceipt) {
  const decide = (reason: WebhookGroupingReason, groupId?: string) => tx.webhookGroupingDecision.create({ data: {
    workspaceId: row.workspaceId, receiptId: row.id, reason, groupingVersion: WEBHOOK_GROUPING_VERSION, ...(groupId ? { groupId } : {}),
  } });
  if (row.validationStatus !== "MISMATCH") return decide("NOT_A_MISMATCH");
  if (row.apiKey !== "synthetic-webhook-payments" || row.environment !== "default" || row.operationPath !== "/payments") return decide("INELIGIBLE_SCOPE");
  if (row.senderVerification === null) return decide("SENDER_UNVERIFIED");
  const proof = webhookVerificationSchema.safeParse(row.senderVerification);
  if (!proof.success) return decide("SENDER_PROVENANCE_INVALID");
  const sender = proof.data;
  const binding = await tx.senderBinding.findFirst({ where: { workspaceId: row.workspaceId, id: sender.bindingId,
    ingestionCredentialId: row.collectorCredentialId, apiKey: row.apiKey, environment: row.environment, senderId: sender.senderId,
    principalRef: sender.principalRef, principalKind: sender.principalKind } });
  // Revocation after acceptance does not rewrite historical proof or require the original signing key.
  if (!binding) return decide("SENDER_PROVENANCE_INVALID");
  const pin = webhookRevisionSelectionSchema.safeParse(row.revisionSelection);
  const spec = row.apiSpecId ? await tx.apiSpec.findFirst({ where: { id: row.apiSpecId, workspaceId: row.workspaceId,
    apiKey: row.apiKey, environment: row.environment }, select: { id: true, sourceSha256: true } }) : null;
  if (!pin.success || !spec || pin.data.apiSpecId !== spec.id || pin.data.sourceSha256 !== spec.sourceSha256) return decide("REVISION_UNAVAILABLE");
  const evidence = evidenceSchema.safeParse(row.validationEvidence);
  const body = protectedWebhookSchema.safeParse({ payload: row.sanitizedPayload, protection: row.protection });
  if (!evidence.success || evidence.data.specRevision.apiSpecId !== spec.id || evidence.data.specRevision.sourceSha256 !== spec.sourceSha256 ||
    !body.success || body.data.protection.omittedFields.length) return decide("EVIDENCE_UNSUPPORTED");
  const driftFingerprint = webhookDriftFingerprint(evidence.data.findings);
  if (!driftFingerprint) return decide("EVIDENCE_UNSUPPORTED");
  const window = groupingWindowForReceivedAt(row.receivedAt);
  const dimensions = { workspaceId: row.workspaceId, apiKey: row.apiKey, environment: row.environment,
    operationPath: row.operationPath, senderId: sender.senderId, apiSpecId: spec.id, sourceSha256: spec.sourceSha256,
    driftFingerprint, windowStart: window.start, groupingVersion: WEBHOOK_GROUPING_VERSION };
  const lock = JSON.stringify(["webhook-drift@1", dimensions]);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))::text`;
  const group = await tx.webhookDriftGroup.findFirst({ where: dimensions }) ?? await tx.webhookDriftGroup.create({ data: {
    ...dimensions, httpMethod: "POST", windowEnd: window.end,
  } });
  return decide("GROUPED", group.id);
}
