import type { PrismaClient } from "@/generated/prisma/client";
import { listObservations } from "@/server/dashboard/integration-observations";
import { loadIntegrationDirectory } from "@/server/dashboard/integrations";
export async function integrationStatus(db: PrismaClient, workspaceId: string, now = new Date(), hours = 24) {
    const [directory, observed, calls, failed, changed] = await Promise.all([
        loadIntegrationDirectory(db, workspaceId), listObservations(db, workspaceId, { page: 1 }),
        db.integrationObservation.count({ where: { workspaceId, receivedAt: { gte: new Date(now.getTime() - hours * 3600000) } } }),
        db.integrationWorkflowOutcome.count({ where: { workspaceId, outcome: "FAILED", receivedAt: { gte: new Date(now.getTime() - hours * 3600000) } } }),
        db.integrationObservation.count({ where: { workspaceId, driftSignature: { not: null }, receivedAt: { gte: new Date(now.getTime() - hours * 3600000) } } }),
    ]);
    return { asOf: now.toISOString(), window: "Last " + hours + " hours by receipt time", integrations: directory.integrations.map(i => ({ ...i, reporting: i.lastReceived !== null && now.getTime() - Date.parse(i.lastReceived) < 900000 })), integrationsTruncated: directory.truncated, capturedCalls: calls, changedCalls: changed, reportedFailedOutcomes: failed, unmatchedOutcomes: observed.unmatched,
        coverage: observed.coverage.map(c => ({ integration: c.integration, reportedAt: c.reportedAt, counters: c.counters })), coverageTruncated: observed.coverageTruncated, invalidCoverage: observed.coverageInvalid,
        limitations: ["Counts describe captured evidence, not all API traffic or caused failures.", "Reporting means a call arrived in the last 15 minutes; inactivity is not proof of an outage.", "Unmatched outcomes and coverage are cumulative; other counts use the last "+hours+" hours."] };
}
