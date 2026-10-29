import "server-only";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { protectedWebhookSchema } from "@/lib/ingestion/synthetic-webhook";
import { webhookDisplayState, type WebhookFilters } from "@/lib/dashboard/webhook-receipts";
import { parseStoredValidationEvidence } from "@/lib/agent-evidence/parse-stored-evidence";
import { webhookVerificationSchema } from "@/lib/ingestion/webhook-verification";
import { webhookGroupingLabel, WEBHOOK_GROUPING_VERSION } from "@/lib/ingestion/webhook-drift";
import { webhookRevisionSelectionSchema } from "@/lib/ingestion/webhook-revision";

const listSelect = {
  id: true, receivedAt: true, apiKey: true, environment: true, operationPath: true,
  validationStatus: true, validatedAt: true, apiSpecId: true,
  apiSpec: { select: { id: true, name: true, version: true } },
  outboxEvents: { where: { eventType: "WEBHOOK_VALIDATION_REQUESTED" }, orderBy: { createdAt: "desc" }, take: 1,
    select: { dispatchStatus: true } },
} satisfies Prisma.WebhookReceiptSelect;
type Selected = Prisma.WebhookReceiptGetPayload<{ select: typeof listSelect }>;
function summarize(row: Selected) {
  return { id: row.id, receivedAt: row.receivedAt.toISOString(), service: row.apiKey, environment: row.environment,
    operationPath: row.operationPath, state: webhookDisplayState(row.validationStatus, row.outboxEvents[0]?.dispatchStatus ?? null),
    validatedAt: row.validatedAt?.toISOString() ?? null, specId: row.apiSpecId,
    specLabel: row.apiSpec ? `${row.apiSpec.name} ${row.apiSpec.version}` : "No revision pinned" };
}
export type WebhookReceiptSummary = ReturnType<typeof summarize>;
function scope(workspaceId: string, filters: WebhookFilters): Prisma.WebhookReceiptWhereInput {
  return { workspaceId, ...(filters.environment ? { environment: filters.environment } : {}), ...(filters.service ? { apiKey: filters.service } : {}) };
}
export async function listWebhookReceipts(db: PrismaClient, workspaceId: string, filters: WebhookFilters) {
  const where = scope(workspaceId, filters);
  const [rows, total] = await Promise.all([
    db.webhookReceipt.findMany({ where, select: listSelect, orderBy: [{ receivedAt: "desc" }, { id: "desc" }], skip: (filters.page - 1) * 20, take: 20 }),
    db.webhookReceipt.count({ where }),
  ]);
  return { rows: rows.map(summarize), total, page: filters.page, pages: Math.max(1, Math.ceil(total / 20)) };
}
export async function loadWebhookReceipt(db: PrismaClient, workspaceId: string, receiptId: string, filters: WebhookFilters) {
  if (!z.string().uuid().safeParse(receiptId).success) return null;
  const row = await db.webhookReceipt.findFirst({ where: { ...scope(workspaceId, filters), id: receiptId },
    select: { ...listSelect, sanitizedPayload: true, protection: true, validationEvidence: true, revisionSelection: true, senderVerification: true,
      groupingDecision: { select: { reason: true, groupingVersion: true, group: { select: { id: true, windowStart: true, windowEnd: true,
        _count: { select: { decisions: true } } } } } } } });
  if (!row) return null;
  const protectedBody = protectedWebhookSchema.safeParse({ payload: row.sanitizedPayload, protection: row.protection });
  const parsed = parseStoredValidationEvidence(row.validationEvidence);
  const pin = webhookRevisionSelectionSchema.safeParse(row.revisionSelection);
  const summary = summarize(row);
  const verification = webhookVerificationSchema.safeParse(row.senderVerification);
  const decision = row.groupingDecision;
  const group = decision?.groupingVersion === WEBHOOK_GROUPING_VERSION && decision.reason === "GROUPED" ? decision.group : null;
  const integrityKnown = protectedBody.success && pin.success && pin.data.apiSpecId === row.apiSpecId;
  return { ...summary, state: !integrityKnown && summary.state !== "Failed" ? "Incomplete" as const : summary.state,
    groupingLabel: !decision && summary.state === "Failed" && row.validationStatus === "NOT_RUN" ? "Not evaluated · validation did not complete" :
      decision && decision.groupingVersion !== WEBHOOK_GROUPING_VERSION ? "Grouping version unavailable" : webhookGroupingLabel(decision?.reason ?? null, row.validationStatus),
    driftGroup: group ? { id: group.id, count: group._count.decisions, windowStart: group.windowStart.toISOString(), windowEnd: group.windowEnd.toISOString() } : null,
    senderVerification: verification.success ? { verifiedAt: verification.data.verifiedAt, signedAt: verification.data.signedAt,
      senderId: verification.data.senderId, principalKind: verification.data.principalKind } : null,
    verificationLabel: verification.success ? "Synthetic signing key verified" : row.senderVerification === null ? "Not verified · unsigned synthetic fixture" : "Verification provenance unavailable",
    selectionLabel: pin.success && pin.data.apiSpecId === row.apiSpecId ? pin.data.version === "configured-at-acceptance@1" ?
      "Server-configured revision · runtime unverified" : "Active at acceptance · runtime unverified" : "Selection provenance unavailable",
    integrityNote: integrityKnown ? null : "Stored protection or revision metadata is unavailable. Treat this result as incomplete.",
    payload: protectedBody.success ? JSON.stringify(protectedBody.data.payload, null, 2) : null,
    omissions: protectedBody.success ? protectedBody.data.protection.omittedFields : null,
    policy: protectedBody.success ? protectedBody.data.protection.policy : null,
    sourceSha256: pin.success ? pin.data.sourceSha256 : null,
    findings: parsed.format === "v1" ? parsed.findings.slice(0, 32).map((finding) => ({
      path: finding.jsonPointer.slice(0, 256), rule: finding.keyword.slice(0, 64), expected: finding.expected?.slice(0, 256) ?? null,
      received: finding.observedType?.slice(0, 64) ?? null, missingProperty: finding.missingProperty?.slice(0, 128) ?? null,
    })) : [],
    reasonCode: parsed.format === "v1" ? parsed.reasonCode?.slice(0, 128) ?? null : null,
  };
}
export type WebhookReceiptDetail = NonNullable<Awaited<ReturnType<typeof loadWebhookReceipt>>>;
