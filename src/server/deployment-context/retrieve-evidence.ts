import { createHash } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { DeploymentEventStatus } from "@/generated/prisma/client";
import {
  DEPLOYMENT_CODE_ASSOCIATION_NOTE,
  DEPLOYMENT_CONTEXT_LIMITS,
  DEPLOYMENT_RUNNING_VERSION_UNKNOWN,
  DEPLOYMENT_TEMPORAL_NOTE,
} from "@/lib/deployment-context/config";

export type DeploymentEvidenceItemV1 = {
  id: string;
  deploymentRecordId: string;
  sourceDeploymentRef: string;
  integrationKey: string;
  status: DeploymentEventStatus;
  sourceReportedAt: string;
  receivedAt: string;
  repository: string | null;
  commitSha: string | null;
  artifactRef: string | null;
  apiSpecId: string | null;
  replacesSourceDeploymentId: string | null;
  runningVersionAssessment: "unknown" | "single_candidate" | "ambiguous";
  repositoryCommitMatch: "unknown" | "matches_selected_snapshot" | "mismatched_selected_snapshot" | "not_applicable";
  retrievalMethod: string;
  limitations: string[];
};

export type RetrieveDeploymentEvidenceInput = {
  workspaceId: string;
  apiKey: string;
  environment: string;
  referenceOccurredAt: Date;
  earliestIncidentReceivedAt: Date;
  repositorySnapshotCommitSha?: string | null;
};

export type RetrieveDeploymentEvidenceResult =
  | {
      ok: true;
      items: DeploymentEvidenceItemV1[];
      missingContext: string[];
      limitations: string[];
      fingerprint: string;
    }
  | { ok: false; code: string };

function evidenceId(recordId: string, eventId: string): string {
  const digest = createHash("sha256").update(`${recordId}\0${eventId}`, "utf8").digest("hex").slice(0, 10);
  return `dp-${digest}`;
}

export function opaqueDeploymentRef(sourceDeploymentId: string): string {
  const digest = createHash("sha256").update(sourceDeploymentId, "utf8").digest("hex").slice(0, 12);
  return `dep-${digest}`;
}

export async function retrieveDeploymentEvidence(
  prisma: PrismaClient,
  input: RetrieveDeploymentEvidenceInput,
): Promise<RetrieveDeploymentEvidenceResult> {
  const windowStart = new Date(
    input.referenceOccurredAt.getTime() - DEPLOYMENT_CONTEXT_LIMITS.lookbackBeforeReferenceMs,
  );
  const limitations = [DEPLOYMENT_TEMPORAL_NOTE, DEPLOYMENT_CODE_ASSOCIATION_NOTE];
  const missingContext: string[] = [];

  if (input.earliestIncidentReceivedAt.getTime() < input.referenceOccurredAt.getTime()) {
    limitations.push("Incident receipt preceded occurrence time; deployment ordering uses occurrence time.");
  }
  if (input.referenceOccurredAt.getTime() > Date.now() + DEPLOYMENT_CONTEXT_LIMITS.maxFutureSkewMs) {
    limitations.push("Reference occurrence time is in the future relative to server clock.");
  }

  const records = await prisma.deploymentRecord.findMany({
    where: {
      workspaceId: input.workspaceId,
      apiKey: input.apiKey,
      environment: input.environment,
    },
    include: {
      events: {
        where: {
          sourceReportedAt: {
            lte: input.referenceOccurredAt,
            gte: windowStart,
          },
        },
        orderBy: { sourceReportedAt: "asc" },
      },
    },
    orderBy: { createdAt: "desc" },
    take: DEPLOYMENT_CONTEXT_LIMITS.maxRecordsPerRetrieval * 2,
  });

  const candidates: Array<{
    record: (typeof records)[number];
    latestEvent: (typeof records)[number]["events"][number];
  }> = [];

  for (const record of records) {
    if (record.events.length === 0) {
      continue;
    }
    const latestEvent = record.events[record.events.length - 1]!;
    candidates.push({ record, latestEvent });
  }

  candidates.sort(
    (a, b) => b.latestEvent.sourceReportedAt.getTime() - a.latestEvent.sourceReportedAt.getTime(),
  );

  const trimmed = candidates.slice(0, DEPLOYMENT_CONTEXT_LIMITS.maxRecordsPerRetrieval);
  if (trimmed.length === 0) {
    missingContext.push("No deployment events were recorded in the configured lookback window before the incident.");
  }

  const succeeded = trimmed.filter((row) => row.latestEvent.status === DeploymentEventStatus.SUCCEEDED);
  let runningVersionAssessment: DeploymentEvidenceItemV1["runningVersionAssessment"] = "unknown";
  if (succeeded.length === 1) {
    runningVersionAssessment = "single_candidate";
  } else if (succeeded.length > 1) {
    runningVersionAssessment = "ambiguous";
    limitations.push(DEPLOYMENT_RUNNING_VERSION_UNKNOWN);
  } else if (trimmed.some((row) => row.latestEvent.status === DeploymentEventStatus.STARTED)) {
    limitations.push("At least one deployment lacked a completion event before the incident reference time.");
  }

  const items: DeploymentEvidenceItemV1[] = trimmed.map(({ record, latestEvent }) => {
    let repositoryCommitMatch: DeploymentEvidenceItemV1["repositoryCommitMatch"] = "not_applicable";
    if (input.repositorySnapshotCommitSha && record.commitSha) {
      repositoryCommitMatch =
        input.repositorySnapshotCommitSha === record.commitSha
          ? "matches_selected_snapshot"
          : "mismatched_selected_snapshot";
    } else if (input.repositorySnapshotCommitSha) {
      repositoryCommitMatch = "unknown";
    }

    return {
      id: evidenceId(record.id, latestEvent.id),
      deploymentRecordId: record.id,
      sourceDeploymentRef: opaqueDeploymentRef(record.sourceDeploymentId),
      integrationKey: record.integrationKey,
      status: latestEvent.status,
      sourceReportedAt: latestEvent.sourceReportedAt.toISOString(),
      receivedAt: latestEvent.receivedAt.toISOString(),
      repository: record.repository,
      commitSha: record.commitSha,
      artifactRef: record.artifactRef,
      apiSpecId: record.apiSpecId,
      replacesSourceDeploymentId: record.replacesSourceDeploymentId,
      runningVersionAssessment,
      repositoryCommitMatch,
      retrievalMethod: "temporal_window:latest_status_at_reference",
      limitations,
    };
  });

  const fingerprint = createHash("sha256")
    .update(
      items.map((row) => `${row.deploymentRecordId}:${row.sourceReportedAt}:${row.status}`).sort().join(";"),
      "utf8",
    )
    .digest("hex");

  return { ok: true, items, missingContext, limitations, fingerprint };
}
