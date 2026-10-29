import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { canonical } from "@/lib/integration-observations/contract";
import {
  changeSignature,
  detectIntegrationChange,
} from "@/lib/integration-observations/detector";
import { lockIntegrationKeys } from "@/server/integration-observations/ingest";

type LinkScope = {
  workspaceId: string;
  integrationKey: string;
  providerKey: string;
  environment: string;
  correlationKind: string | null;
  correlationId: string | null;
  correlationAttempt: number | null;
};
async function correlationLock(
  tx: Prisma.TransactionClient,
  scope: LinkScope,
  id: string,
) {
  await lockIntegrationKeys(tx, [
    canonical([
      "outcome-link",
      scope.workspaceId,
      scope.integrationKey,
      scope.providerKey,
      scope.environment,
      scope.correlationKind,
      scope.correlationId ?? id,
      scope.correlationAttempt,
    ]),
  ]);
}
function correlationWhere(scope: LinkScope) {
  return {
    workspaceId: scope.workspaceId,
    integrationKey: scope.integrationKey,
    providerKey: scope.providerKey,
    environment: scope.environment,
    correlationKind: scope.correlationKind!,
    correlationId: scope.correlationId!,
    correlationAttempt: scope.correlationAttempt!,
  };
}
export async function processIntegrationObservation(
  db: PrismaClient,
  workspaceId: string,
  id: string,
) {
  return db.$transaction(async (tx) => {
    const initial = await tx.integrationObservation.findFirst({
      where: { workspaceId, id },
    });
    if (!initial) return { status: "skipped", reason: "not_found" };
    await correlationLock(tx, initial, id);
    await tx.$queryRaw`SELECT id FROM integration_observations WHERE workspace_id=${workspaceId}::uuid AND id=${id}::uuid FOR UPDATE`;
    const row = await tx.integrationObservation.findFirst({
      where: { workspaceId, id },
    });
    if (!row) return { status: "skipped", reason: "not_found" };
    if (row.processingState === "DONE")
      return { status: "skipped", reason: "already_completed" };
    const baseline = row.baselineId
      ? await tx.integrationResponseBaseline.findFirst({
          where: { workspaceId, id: row.baselineId, scopeKey: row.scopeKey },
          select: {
            id: true,
            version: true,
            origin: true,
            expectedShape: true,
          },
        })
      : null;
    const evidence = detectIntegrationChange(row.envelope, baseline);
    let linkTruncated = false;
    if (row.correlationKind && row.correlationId && row.correlationAttempt) {
      const outcomes = await tx.integrationWorkflowOutcome.findMany({
        where: correlationWhere(row),
        orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
        take: 101,
        select: { id: true },
      });
      linkTruncated = outcomes.length > 100;
      for (const outcome of outcomes.slice(0, 100)) {
        const existing = await tx.integrationOutcomeLink.findMany({
          where: { workspaceId, outcomeId: outcome.id },
          select: { observationId: true },
          take: 101,
        });
        if (existing.some((link) => link.observationId === row.id)) continue;
        if (existing.length >= 100) {
          linkTruncated = true;
          await tx.integrationWorkflowOutcome.update({
            where: { id: outcome.id },
            data: { linkTruncated: true },
          });
          continue;
        }
        await tx.integrationOutcomeLink.create({
          data: { workspaceId, observationId: row.id, outcomeId: outcome.id },
        });
      }
    }
    await tx.integrationObservation.update({
      where: { id: row.id },
      data: {
        detectorEvidence: evidence,
        driftSignature: changeSignature(evidence),
        processingState: "DONE",
        processedAt: new Date(),
        linkTruncated,
      },
    });
    return { status: "processed", code: evidence.code };
  });
}
export async function processIntegrationOutcome(
  db: PrismaClient,
  workspaceId: string,
  id: string,
) {
  return db.$transaction(async (tx) => {
    const initial = await tx.integrationWorkflowOutcome.findFirst({
      where: { workspaceId, id },
    });
    if (!initial) return { status: "skipped", reason: "not_found" };
    await correlationLock(tx, initial, id);
    await tx.$queryRaw`SELECT id FROM integration_workflow_outcomes WHERE workspace_id=${workspaceId}::uuid AND id=${id}::uuid FOR UPDATE`;
    const row = await tx.integrationWorkflowOutcome.findFirst({
      where: { workspaceId, id },
    });
    if (!row) return { status: "skipped", reason: "not_found" };
    if (row.processingState === "DONE")
      return { status: "skipped", reason: "already_completed" };
    const observations = await tx.integrationObservation.findMany({
      where: correlationWhere(row),
      orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
      take: 101,
      select: { id: true },
    });
    const existing = await tx.integrationOutcomeLink.findMany({
      where: { workspaceId, outcomeId: row.id },
      select: { observationId: true },
      take: 101,
    });
    const existingIds = new Set(existing.map((link) => link.observationId));
    const candidates = observations.filter(
      (observation) => !existingIds.has(observation.id),
    );
    const remaining = Math.max(0, 100 - existing.length);
    const additions = candidates.slice(0, remaining);
    if (additions.length)
      await tx.integrationOutcomeLink.createMany({
        data: additions.map((observation) => ({
          workspaceId,
          observationId: observation.id,
          outcomeId: row.id,
        })),
        skipDuplicates: true,
      });
    await tx.integrationWorkflowOutcome.update({
      where: { id: row.id },
      data: {
        processingState: "DONE",
        processedAt: new Date(),
        linkTruncated:
          row.linkTruncated ||
          observations.length > 100 ||
          candidates.length > remaining,
      },
    });
    return {
      status: "processed",
      linked: existing.length + additions.length,
      unmatched: !observations.length,
    };
  });
}
