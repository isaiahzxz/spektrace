import type { PrismaClient } from "@/generated/prisma/client";
import { getIncidentQueue } from "@/lib/queue/incident-queue";
export async function reconcileIntegrationOutbox(db: PrismaClient) {
  const rows = await db.outboxEvent.findMany({
    where: {
      dispatchStatus: "PUBLISHED",
      publishedAt: { lt: new Date(Date.now() - 30_000) },
      OR: [
        {
          eventType: "INTEGRATION_OBSERVATION_REQUESTED",
          integrationObservation: { processingState: "PENDING" },
        },
        {
          eventType: "INTEGRATION_OUTCOME_REQUESTED",
          integrationOutcome: { processingState: "PENDING" },
        },
      ],
    },
    orderBy: { publishedAt: "asc" },
    take: 20,
  });
  let recovered = 0;
  for (const row of rows) {
    const job = await getIncidentQueue().getJob(row.id),
      state = job ? await job.getState() : null,
      failed = state === "failed" || state === "completed";
    if (job && !failed) continue;
    const changed = await db.outboxEvent.updateMany({
      where: {
        id: row.id,
        workspaceId: row.workspaceId,
        eventType: row.eventType,
        dispatchStatus: "PUBLISHED",
        publishedAt: row.publishedAt,
        ...(row.integrationObservationId
          ? {
              integrationObservationId: row.integrationObservationId,
              integrationObservation: { processingState: "PENDING" },
            }
          : {
              integrationOutcomeId: row.integrationOutcomeId,
              integrationOutcome: { processingState: "PENDING" },
            }),
      },
      data: {
        dispatchStatus: failed ? "FAILED" : "PENDING",
        lastError: failed
          ? "INTEGRATION_JOB_TERMINAL_WITHOUT_EVIDENCE"
          : "INTEGRATION_JOB_MISSING_REQUEUED",
      },
    });
    recovered += changed.count;
  }
  return recovered;
}
