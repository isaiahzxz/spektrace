import { OutboxEventType } from "@/generated/prisma/client";

export function outboxDedupeKeyForValidation(incidentId: string): string {
  return `validation:${incidentId}`;
}

export function outboxDedupeKeyForGrouping(incidentId: string): string {
  return `grouping:${incidentId}`;
}

export function outboxDedupeKeyForGroupPreparation(investigationGroupId: string): string {
  return `preparation:${investigationGroupId}`;
}

export function outboxDedupeKeyForGroupInference(evidencePreparationRunId: string): string {
  return `inference:${evidencePreparationRunId}`;
}

export function outboxEventTypeForDedupeKey(dedupeKey: string): OutboxEventType {
  if (dedupeKey.startsWith("validation:")) {
    return OutboxEventType.INCIDENT_VALIDATION_REQUESTED;
  }
  if (dedupeKey.startsWith("grouping:")) {
    return OutboxEventType.INCIDENT_INVESTIGATION_GROUPING_REQUESTED;
  }
  if (dedupeKey.startsWith("inference:")) {
    return OutboxEventType.INVESTIGATION_GROUP_INFERENCE_REQUESTED;
  }
  return OutboxEventType.INVESTIGATION_GROUP_PREPARATION_REQUESTED;
}
