import { processIntegrationObservation, processIntegrationOutcome } from "@/server/integration-observations/process";
import type { IncidentJobPayload } from "@/lib/queue/job-types";
import type { createPrismaClientForUrl } from "@/lib/db";
import { assignIncidentToInvestigationGroup } from "@/server/services/assign-incident-investigation-group";
import { processEvidencePreparation } from "@/server/services/process-evidence-preparation";
import { processInvestigationInference } from "@/server/services/process-investigation-inference";
import { processIncidentValidation } from "@/server/services/process-incident-validation";

import { processStripeWebhookValidation } from "@/server/services/process-stripe-webhook-validation";
import { processWebhookValidation } from "@/server/services/process-webhook-validation";
export async function routeWorkerJob(
  prisma: ReturnType<typeof createPrismaClientForUrl>,
  payload: IncidentJobPayload,
) {
  if (payload.task === "observe-integration") {
    if (!payload.integrationObservationId) throw new Error("Integration observation id missing");
    return processIntegrationObservation(prisma,payload.workspaceId,payload.integrationObservationId);
  }
  if (payload.task === "link-integration-outcome") {
    if (!payload.integrationOutcomeId) throw new Error("Integration outcome id missing");
    return processIntegrationOutcome(prisma,payload.workspaceId,payload.integrationOutcomeId);
  }
  if (payload.task === "validate-stripe-webhook") {
    if (!payload.stripeWebhookReceiptId) throw new Error("Stripe job missing receipt id");
    return processStripeWebhookValidation(prisma, payload.workspaceId, payload.stripeWebhookReceiptId);
  }
  if (payload.task === 'validate-webhook') {
    if (!payload.webhookReceiptId) throw new Error('Webhook job missing receipt id');
    return processWebhookValidation(prisma, payload.workspaceId, payload.webhookReceiptId);
  }
  if (payload.task === "assign-group") {
    if (!payload.incidentId) {
      throw new Error("assign-group job missing incidentId");
    }
    return assignIncidentToInvestigationGroup(
      prisma,
      payload.workspaceId,
      payload.incidentId,
    );
  }

  if (payload.task === "prepare-evidence") {
    if (!payload.investigationGroupId) {
      throw new Error("prepare-evidence job missing investigationGroupId");
    }
    return processEvidencePreparation(
      prisma,
      payload.workspaceId,
      payload.investigationGroupId,
    );
  }

  if (payload.task === "run-inference") {
    if (!payload.evidencePreparationRunId) {
      throw new Error("run-inference job missing evidencePreparationRunId");
    }
    return processInvestigationInference(
      prisma,
      payload.workspaceId,
      payload.evidencePreparationRunId,
    );
  }

  if (!payload.incidentId) {
    throw new Error("validate job missing incidentId");
  }
  return processIncidentValidation(
    prisma,
    payload.workspaceId,
    payload.incidentId,
  );
}

