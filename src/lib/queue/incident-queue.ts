import { Queue } from "bullmq";
import {
  getIncidentQueueName,
  type IncidentJobPayload,
} from "@/lib/queue/job-types";
import { getProducerRedis } from "@/lib/redis";

let incidentQueue: Queue<IncidentJobPayload> | null = null;

export function getIncidentQueue(): Queue<IncidentJobPayload> {
  if (!incidentQueue) {
    incidentQueue = new Queue<IncidentJobPayload>(getIncidentQueueName(), {
      connection: getProducerRedis(),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    });
  }
  return incidentQueue;
}

function defaultJobId(payload: IncidentJobPayload): string {
  if (payload.task === "observe-integration" && payload.integrationObservationId) return `${payload.workspaceId}-integration-${payload.integrationObservationId}`;
  if (payload.task === "link-integration-outcome" && payload.integrationOutcomeId) return `${payload.workspaceId}-outcome-${payload.integrationOutcomeId}`;
  if (payload.task === "validate-stripe-webhook" && payload.stripeWebhookReceiptId) {
    return `${payload.workspaceId}-stripe-${payload.stripeWebhookReceiptId}`;
  }
  if (payload.task === "validate-webhook" && payload.webhookReceiptId) {
    return `${payload.workspaceId}:webhook:${payload.webhookReceiptId}`;
  }
  if (payload.task === "prepare-evidence" && payload.investigationGroupId) {
    return `${payload.workspaceId}:prepare:${payload.investigationGroupId}`;
  }
  if (payload.incidentId) {
    return `${payload.workspaceId}:${payload.task}:${payload.incidentId}`;
  }
  throw new Error("Cannot derive job id from worker payload");
}

export async function enqueueIncidentJob(
  payload: IncidentJobPayload,
  options?: { jobId?: string },
): Promise<void> {
  const queue = getIncidentQueue();
  const redis = getProducerRedis();
  if (redis.status !== "ready") {
    await redis.connect();
  }
  await queue.add(payload.task, payload, {
    jobId: options?.jobId ?? defaultJobId(payload),
  });
}

export async function resetIncidentQueueForTests(): Promise<void> {
  if (incidentQueue) {
    await incidentQueue.close();
    incidentQueue = null;
  }
}
