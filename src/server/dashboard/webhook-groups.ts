import "server-only";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { webhookDisplayState, type WebhookFilters } from "@/lib/dashboard/webhook-receipts";
import { WEBHOOK_GROUPING_VERSION } from "@/lib/ingestion/webhook-drift";

const groupSelect = {
  id: true, apiKey: true, environment: true, httpMethod: true, operationPath: true, senderId: true, apiSpecId: true,
  sourceSha256: true, driftFingerprint: true, windowStart: true, windowEnd: true,
  sender: { select: { displayName: true } }, apiSpec: { select: { name: true, version: true } },
  _count: { select: { decisions: { where: { reason: "GROUPED", groupingVersion: WEBHOOK_GROUPING_VERSION } } } },
} satisfies Prisma.WebhookDriftGroupSelect;
function scope(workspaceId: string, filters: WebhookFilters): Prisma.WebhookDriftGroupWhereInput {
  return { workspaceId, groupingVersion: WEBHOOK_GROUPING_VERSION,
    ...(filters.environment ? { environment: filters.environment } : {}), ...(filters.service ? { apiKey: filters.service } : {}) };
}
function summarize(row: Prisma.WebhookDriftGroupGetPayload<{ select: typeof groupSelect }>) {
  return { id: row.id, service: row.apiKey, environment: row.environment, method: row.httpMethod, operationPath: row.operationPath,
    senderId: row.senderId, senderLabel: row.sender.displayName, specId: row.apiSpecId, specLabel: `${row.apiSpec.name} ${row.apiSpec.version}`,
    sourceSha256: row.sourceSha256, driftFingerprint: row.driftFingerprint, count: row._count.decisions,
    windowStart: row.windowStart.toISOString(), windowEnd: row.windowEnd.toISOString() };
}
export type WebhookGroupSummary = ReturnType<typeof summarize>;
export async function listWebhookGroups(db: PrismaClient, workspaceId: string, filters: WebhookFilters) {
  const where = scope(workspaceId, filters);
  const [rows, total] = await Promise.all([
    db.webhookDriftGroup.findMany({ where, select: groupSelect, orderBy: [{ windowStart: "desc" }, { id: "desc" }], skip: (filters.page - 1) * 20, take: 20 }),
    db.webhookDriftGroup.count({ where }),
  ]);
  return { rows: rows.map(summarize), total };
}
export async function loadWebhookGroup(db: PrismaClient, workspaceId: string, groupId: string, filters: WebhookFilters, memberPage: number) {
  if (!z.string().uuid().safeParse(groupId).success || !z.number().int().min(1).max(10000).safeParse(memberPage).success) return null;
  const row = await db.webhookDriftGroup.findFirst({ where: { ...scope(workspaceId, filters), id: groupId }, select: groupSelect });
  if (!row) return null;
  const memberships = await db.webhookGroupingDecision.findMany({ where: { workspaceId, groupId: row.id, reason: "GROUPED", groupingVersion: WEBHOOK_GROUPING_VERSION },
    orderBy: [{ createdAt: "asc" }, { receiptId: "asc" }], skip: (memberPage - 1) * 20, take: 20,
    select: { receipt: { select: { id: true, receivedAt: true, apiKey: true, environment: true, operationPath: true, validationStatus: true,
      validatedAt: true, apiSpecId: true, apiSpec: { select: { name: true, version: true } } } } } });
  return { group: summarize(row), memberPage, receipts: memberships.map(({ receipt }) => ({ id: receipt.id, receivedAt: receipt.receivedAt.toISOString(),
    service: receipt.apiKey, environment: receipt.environment, operationPath: receipt.operationPath, state: webhookDisplayState(receipt.validationStatus, null),
    validatedAt: receipt.validatedAt?.toISOString() ?? null, specId: receipt.apiSpecId,
    specLabel: receipt.apiSpec ? `${receipt.apiSpec.name} ${receipt.apiSpec.version}` : "No revision pinned" })) };
}
export type WebhookGroupDetail = NonNullable<Awaited<ReturnType<typeof loadWebhookGroup>>>;
