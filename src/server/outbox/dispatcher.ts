import { randomUUID } from "node:crypto";
import { OutboxDispatchStatus, OutboxEventType } from "@/generated/prisma/client";
import type { PrismaClient } from "@/generated/prisma/client";
import type { IncidentJobPayload } from "@/lib/queue/job-types";
import { enqueueIncidentJob, getIncidentQueue } from "@/lib/queue/incident-queue";

const BATCH_SIZE = 20;

export type OutboxDispatcherOptions = {
  workspaceId?: string;
  workerId?: string;
  batchSize?: number;
  publishJob?: typeof enqueueIncidentJob;
};

function payloadForOutboxRow(row: {
  workspace_id: string;
  incident_id: string | null;
  webhook_receipt_id: string | null;
  stripe_webhook_receipt_id?: string | null;
  integration_observation_id?: string | null;
  integration_outcome_id?: string | null;
  investigation_group_id: string | null;
  evidence_preparation_run_id: string | null;
  event_type: OutboxEventType;
}): IncidentJobPayload {
  if (row.event_type === OutboxEventType.INTEGRATION_OBSERVATION_REQUESTED) {
    if (!row.integration_observation_id) throw new Error("Integration outbox target missing");
    return {workspaceId:row.workspace_id,integrationObservationId:row.integration_observation_id,task:"observe-integration"};
  }
  if (row.event_type === OutboxEventType.INTEGRATION_OUTCOME_REQUESTED) {
    if (!row.integration_outcome_id) throw new Error("Outcome outbox target missing");
    return {workspaceId:row.workspace_id,integrationOutcomeId:row.integration_outcome_id,task:"link-integration-outcome"};
  }
  if (row.event_type === OutboxEventType.STRIPE_WEBHOOK_VALIDATION_REQUESTED) {
    if (!row.stripe_webhook_receipt_id) throw new Error("Stripe outbox row missing receipt");
    return { workspaceId: row.workspace_id, stripeWebhookReceiptId: row.stripe_webhook_receipt_id, task: "validate-stripe-webhook" };
  }
  if (row.event_type === OutboxEventType.WEBHOOK_VALIDATION_REQUESTED) {
    if (!row.webhook_receipt_id) throw new Error('Webhook outbox row missing receipt');
    return { workspaceId: row.workspace_id, webhookReceiptId: row.webhook_receipt_id, task: 'validate-webhook' };
  }

  if (row.event_type === OutboxEventType.INVESTIGATION_GROUP_INFERENCE_REQUESTED) {
    if (!row.evidence_preparation_run_id) {
      throw new Error("Inference outbox row is missing evidence_preparation_run_id");
    }
    return {
      workspaceId: row.workspace_id,
      investigationGroupId: row.investigation_group_id ?? undefined,
      evidencePreparationRunId: row.evidence_preparation_run_id,
      task: "run-inference",
    };
  }

  if (row.event_type === OutboxEventType.INVESTIGATION_GROUP_PREPARATION_REQUESTED) {
    if (!row.investigation_group_id) {
      throw new Error("Preparation outbox row is missing investigation_group_id");
    }
    return {
      workspaceId: row.workspace_id,
      investigationGroupId: row.investigation_group_id,
      task: "prepare-evidence",
    };
  }

  if (!row.incident_id) {
    throw new Error("Incident outbox row is missing incident_id");
  }

  if (row.event_type === OutboxEventType.INCIDENT_INVESTIGATION_GROUPING_REQUESTED) {
    return {
      workspaceId: row.workspace_id,
      incidentId: row.incident_id,
      task: "assign-group",
    };
  }

  return {
    workspaceId: row.workspace_id,
    incidentId: row.incident_id,
    task: "validate",
  };
}

export async function dispatchOutboxBatch(
  prisma: PrismaClient,
  options: OutboxDispatcherOptions = {},
): Promise<number> {
  const workerId = options.workerId ?? `worker-${randomUUID()}`;
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const publishJob = options.publishJob ?? enqueueIncidentJob;
  let published = 0;

  for (let i = 0; i < batchSize; i += 1) {
    const claimed = await prisma.$queryRaw<
      Array<{
        id: string;
        workspace_id: string;
        incident_id: string | null;
  webhook_receipt_id: string | null;
  stripe_webhook_receipt_id?: string | null;
  integration_observation_id?: string | null;
  integration_outcome_id?: string | null;
        investigation_group_id: string | null;
        evidence_preparation_run_id: string | null;
        event_type: OutboxEventType;
      }>
    >`
      UPDATE outbox_events
      SET
        dispatch_status = 'CLAIMED'::outbox_dispatch_status,
        claimed_at = NOW(),
        claim_expires_at = NOW() + interval '30 seconds',
        claimed_by = ${workerId},
        attempt_count = attempt_count + 1,
        updated_at = NOW()
      WHERE id = (
        SELECT id
        FROM outbox_events
        WHERE
          (${options.workspaceId ?? null}::uuid IS NULL OR workspace_id = ${options.workspaceId ?? null}::uuid)
          AND (dispatch_status = 'PENDING'::outbox_dispatch_status
          OR (
            dispatch_status = 'CLAIMED'::outbox_dispatch_status
            AND claim_expires_at IS NOT NULL
            AND claim_expires_at < NOW()
          )
          )
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, workspace_id, integration_observation_id, integration_outcome_id, stripe_webhook_receipt_id, webhook_receipt_id, incident_id, investigation_group_id, evidence_preparation_run_id, event_type
    `;

    const row = claimed[0];
    if (!row) {
      break;
    }

    try {
      const payload = payloadForOutboxRow(row);
      await publishJob(payload, { jobId: row.id });

      await prisma.outboxEvent.update({
        where: { id: row.id },
        data: {
          dispatchStatus: OutboxDispatchStatus.PUBLISHED,
          publishedAt: new Date(),
          claimExpiresAt: null,
          lastError: null,
        },
      });
      published += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "enqueue failed";
      await prisma.outboxEvent.update({
        where: { id: row.id },
        data: {
          dispatchStatus: OutboxDispatchStatus.PENDING,
          claimExpiresAt: null,
          lastError: message.slice(0, 500),
        },
      });
    }
  }

  return published;
}

export async function recoverPublishedOutboxOrphans(prisma: PrismaClient): Promise<number> {
  const rows = await prisma.outboxEvent.findMany({
    where: {
      dispatchStatus: OutboxDispatchStatus.CLAIMED,
      claimExpiresAt: { lt: new Date() },
    },
    take: 50,
  });

  let recovered = 0;
  for (const row of rows) {
    try {
      const payload = payloadForOutboxRow({
        workspace_id: row.workspaceId,
        incident_id: row.incidentId,
        webhook_receipt_id: row.webhookReceiptId,
        stripe_webhook_receipt_id: row.stripeWebhookReceiptId,
        integration_observation_id: row.integrationObservationId,
        integration_outcome_id: row.integrationOutcomeId,
        investigation_group_id: row.investigationGroupId,
        evidence_preparation_run_id: row.evidencePreparationRunId,
        event_type: row.eventType,
      });
      await enqueueIncidentJob(payload, { jobId: row.id });
      await prisma.outboxEvent.update({
        where: { id: row.id },
        data: {
          dispatchStatus: OutboxDispatchStatus.PUBLISHED,
          publishedAt: new Date(),
          claimExpiresAt: null,
        },
      });
      recovered += 1;
    } catch {
      await prisma.outboxEvent.update({
        where: { id: row.id },
        data: {
          dispatchStatus: OutboxDispatchStatus.PENDING,
          claimExpiresAt: null,
        },
      });
    }
  }
  return recovered;
}

export async function reconcileWebhookOutbox(prisma: PrismaClient): Promise<number> {
  const rows = await prisma.outboxEvent.findMany({ where: {
    OR: [
      { eventType: OutboxEventType.WEBHOOK_VALIDATION_REQUESTED, webhookReceipt: { validationStatus: "NOT_RUN" } },
      { eventType: OutboxEventType.STRIPE_WEBHOOK_VALIDATION_REQUESTED, stripeWebhookReceipt: { validationStatus: "NOT_RUN" } },
    ],
    dispatchStatus: OutboxDispatchStatus.PUBLISHED,
    publishedAt: { lt: new Date(Date.now() - 30_000) },
  }, orderBy: { publishedAt: "asc" }, take: 20 });
  let recovered = 0;
  for (const row of rows) {
    // A rejected Redis lookup propagates; it is never evidence of a missing job.
    const job = await getIncidentQueue().getJob(row.id);
    const state = job ? await job.getState() : null;
    const failure = state === "failed" || state === "completed";
    if (job && !failure) continue;
    const changed = await prisma.outboxEvent.updateMany({ where: {
      id: row.id, workspaceId: row.workspaceId, webhookReceiptId: row.webhookReceiptId,
      eventType: row.eventType, stripeWebhookReceiptId: row.stripeWebhookReceiptId,
      dispatchStatus: OutboxDispatchStatus.PUBLISHED, publishedAt: row.publishedAt,
      ...(row.eventType === OutboxEventType.STRIPE_WEBHOOK_VALIDATION_REQUESTED
        ? { stripeWebhookReceipt: { validationStatus: "NOT_RUN" as const } }
        : { webhookReceipt: { validationStatus: "NOT_RUN" as const } }),
    }, data: {
      dispatchStatus: failure ? OutboxDispatchStatus.FAILED : OutboxDispatchStatus.PENDING,
      lastError: failure ? "WEBHOOK_JOB_TERMINAL_WITHOUT_VALIDATION" : "WEBHOOK_JOB_MISSING_REQUEUED",
    } });
    recovered += changed.count;
  }
  return recovered;
}
