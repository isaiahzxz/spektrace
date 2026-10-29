import {
  OutboxDispatchStatus,
  OutboxEventType,
  ValidationStatus,
  type Prisma,
  type PrismaClient,
} from "@/generated/prisma/client";
import { isEvidencePreparationEnabled } from "@/lib/investigation/config";
import {
  outboxDedupeKeyForGroupInference,
  outboxDedupeKeyForGroupPreparation,
  outboxDedupeKeyForGrouping,
} from "@/lib/investigation/outbox-keys";
import { isAiInvestigationEnabledForWorkspace } from "@/lib/investigation/inference/config";

type Tx = Prisma.TransactionClient;

export async function scheduleInvestigationGroupingOutbox(
  tx: Tx,
  workspaceId: string,
  incidentId: string,
): Promise<void> {
  if (!isEvidencePreparationEnabled()) {
    return;
  }

  await tx.outboxEvent.upsert({
    where: {
      workspaceId_dedupeKey: {
        workspaceId,
        dedupeKey: outboxDedupeKeyForGrouping(incidentId),
      },
    },
    create: {
      workspaceId,
      incidentId,
      dedupeKey: outboxDedupeKeyForGrouping(incidentId),
      eventType: OutboxEventType.INCIDENT_INVESTIGATION_GROUPING_REQUESTED,
    },
    update: {},
  });
}

export function validationReadyForGrouping(
  validationStatus: ValidationStatus,
): boolean {
  return validationStatus !== ValidationStatus.NOT_RUN;
}

export async function scheduleGroupPreparationOutbox(
  tx: Tx,
  workspaceId: string,
  investigationGroupId: string,
): Promise<void> {
  if (!isEvidencePreparationEnabled()) {
    return;
  }

  await tx.outboxEvent.upsert({
    where: {
      workspaceId_dedupeKey: {
        workspaceId,
        dedupeKey: outboxDedupeKeyForGroupPreparation(investigationGroupId),
      },
    },
    create: {
      workspaceId,
      investigationGroupId,
      dedupeKey: outboxDedupeKeyForGroupPreparation(investigationGroupId),
      eventType: OutboxEventType.INVESTIGATION_GROUP_PREPARATION_REQUESTED,
    },
    update: {
      dispatchStatus: OutboxDispatchStatus.PENDING,
      claimExpiresAt: null,
      claimedAt: null,
      claimedBy: null,
      publishedAt: null,
    },
  });
}

export async function scheduleGroupInferenceOutbox(
  tx: Tx,
  workspaceId: string,
  investigationGroupId: string,
  evidencePreparationRunId: string,
): Promise<void> {
  if (!isEvidencePreparationEnabled()) {
    return;
  }
  if (!isAiInvestigationEnabledForWorkspace(workspaceId)) {
    return;
  }

  await tx.outboxEvent.upsert({
    where: {
      workspaceId_dedupeKey: {
        workspaceId,
        dedupeKey: outboxDedupeKeyForGroupInference(evidencePreparationRunId),
      },
    },
    create: {
      workspaceId,
      investigationGroupId,
      evidencePreparationRunId,
      dedupeKey: outboxDedupeKeyForGroupInference(evidencePreparationRunId),
      eventType: OutboxEventType.INVESTIGATION_GROUP_INFERENCE_REQUESTED,
    },
    update: {
      dispatchStatus: OutboxDispatchStatus.PENDING,
      claimExpiresAt: null,
      claimedAt: null,
      claimedBy: null,
      publishedAt: null,
    },
  });
}

export async function scheduleGroupingForIncidentIfReady(
  prisma: PrismaClient,
  workspaceId: string,
  incidentId: string,
): Promise<void> {
  if (!isEvidencePreparationEnabled()) {
    return;
  }

  const incident = await prisma.incident.findFirst({
    where: { id: incidentId, workspaceId },
    select: { validationStatus: true },
  });
  if (!incident || !validationReadyForGrouping(incident.validationStatus)) {
    return;
  }

  await prisma.$transaction(async (tx) => {
    await scheduleInvestigationGroupingOutbox(tx, workspaceId, incidentId);
  });
}
