import { getRedisKeyPrefix } from "@/lib/internal-config";

export type WorkerTask = "observe-integration" | "link-integration-outcome" | "validate-stripe-webhook" | "validate-webhook" | "validate" | "assign-group" | "prepare-evidence" | "run-inference";

export type IncidentJobPayload = {
  workspaceId: string;
  integrationObservationId?: string;
  integrationOutcomeId?: string;
  incidentId?: string;
  webhookReceiptId?: string;
  stripeWebhookReceiptId?: string;
  investigationGroupId?: string;
  evidencePreparationRunId?: string;
  task: WorkerTask;
};

export function getIncidentQueueName(): string {
  return `${getRedisKeyPrefix()}-incidents`;
}

export function normalizeWorkerPayload(
  data: Partial<IncidentJobPayload> & { workspaceId: string },
): IncidentJobPayload {
  if (data.task) {
    return data as IncidentJobPayload;
  }
  if (data.incidentId) {
    return {
      workspaceId: data.workspaceId,
      incidentId: data.incidentId,
      task: "validate",
    };
  }
  throw new Error("Worker job payload is missing task routing fields");
}
