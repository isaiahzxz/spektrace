import { randomUUID } from "node:crypto";
import {
  EvidencePreparationRunStatus,
  Prisma,
  type PrismaClient,
} from "@/generated/prisma/client";
import { AGENT_EVIDENCE_VERSION } from "@/lib/agent-evidence/agent-evidence-v1";
import {
  EVIDENCE_PREPARATION_BUILDER_VERSION,
  INVESTIGATION_PREPARATION_LIMITS,
} from "@/lib/investigation/config";
import {
  protectedGroupEvidenceSummarySchema,
  type ProtectedGroupEvidenceSummaryV1,
} from "@/lib/investigation/protected-summary-v1";
import {
  scheduleGroupInferenceOutbox,
  scheduleGroupPreparationOutbox,
} from "@/lib/investigation/schedule-outbox";
import {
  AgentEvidenceBuildError,
  AgentEvidenceNotFoundError,
  AgentEvidenceReferenceMismatchError,
  buildAgentEvidenceBundle,
} from "@/server/services/build-agent-evidence";

const CLAIM_TTL_MS = 60_000;
export type ProcessEvidencePreparationResult =
  | { status: "skipped"; reason: string }
  | { status: "processed"; runId: string; runStatus: EvidencePreparationRunStatus };

function failureCodeFromError(error: unknown): string {
  if (error instanceof AgentEvidenceReferenceMismatchError) {
    return error.code;
  }
  if (error instanceof AgentEvidenceBuildError) {
    return error.code;
  }
  if (error instanceof AgentEvidenceNotFoundError) {
    return "INCIDENT_NOT_FOUND";
  }
  return "PREPARATION_EXCEPTION";
}

export async function processEvidencePreparation(
  prisma: PrismaClient,
  workspaceId: string,
  investigationGroupId: string,
  options: { workerId?: string } = {},
): Promise<ProcessEvidencePreparationResult> {
  const workerId = options.workerId ?? `prep-${randomUUID()}`;

  const group = await prisma.investigationGroup.findFirst({
    where: { id: investigationGroupId, workspaceId },
  });
  if (!group) {
    return { status: "skipped", reason: "group_not_found" };
  }

  if (group.membershipVersion <= group.preparedMembershipVersion) {
    return { status: "skipped", reason: "already_prepared" };
  }

  const claim = await prisma.$transaction(async (tx) => {
    const stale = await tx.evidencePreparationRun.findFirst({
      where: {
        workspaceId,
        investigationGroupId,
        status: EvidencePreparationRunStatus.RUNNING,
        claimExpiresAt: { lt: new Date() },
      },
    });
    if (stale) {
      await tx.evidencePreparationRun.update({
        where: { id: stale.id },
        data: {
          status: EvidencePreparationRunStatus.FAILED,
          failureCode: "PREPARATION_CLAIM_EXPIRED",
          completedAt: new Date(),
          claimExpiresAt: null,
          claimedAt: null,
          claimedBy: null,
        },
      });
    }

    const active = await tx.evidencePreparationRun.findFirst({
      where: {
        workspaceId,
        investigationGroupId,
        status: EvidencePreparationRunStatus.RUNNING,
        claimExpiresAt: { gte: new Date() },
      },
    });
    if (active) {
      return { kind: "busy" as const };
    }

    const latestRun = await tx.evidencePreparationRun.findFirst({
      where: { workspaceId, investigationGroupId },
      orderBy: { runSequence: "desc" },
    });

    const targetVersion = group.membershipVersion;
    if (
      latestRun &&
      latestRun.membershipVersion === targetVersion &&
      (latestRun.status === EvidencePreparationRunStatus.EVIDENCE_READY ||
        latestRun.status === EvidencePreparationRunStatus.RUNNING)
    ) {
      return { kind: "noop" as const };
    }

    const nextSequence = (latestRun?.runSequence ?? 0) + 1;
    const run = await tx.evidencePreparationRun.create({
      data: {
        workspaceId,
        investigationGroupId,
        runSequence: nextSequence,
        membershipVersion: targetVersion,
        status: EvidencePreparationRunStatus.RUNNING,
        evidenceFormatVersion: AGENT_EVIDENCE_VERSION,
        builderVersion: EVIDENCE_PREPARATION_BUILDER_VERSION,
        startedAt: new Date(),
        claimedAt: new Date(),
        claimExpiresAt: new Date(Date.now() + CLAIM_TTL_MS),
        claimedBy: workerId,
      },
    });

    return { kind: "claimed" as const, runId: run.id, targetVersion };
  });

  if (claim.kind === "busy") {
    return { status: "skipped", reason: "run_in_progress" };
  }
  if (claim.kind === "noop") {
    return { status: "skipped", reason: "already_prepared" };
  }

  const memberships = await prisma.investigationGroupMembership.findMany({
    where: { workspaceId, investigationGroupId },
    orderBy: { incidentReceivedAt: "asc" },
    select: { incidentId: true },
  });

  const includedIds = memberships
    .slice(0, INVESTIGATION_PREPARATION_LIMITS.maxIncidentsPerRun)
    .map((row) => row.incidentId);
  const omittedIncidentCount = Math.max(
    0,
    memberships.length - includedIds.length,
  );

  const includedIncidents: ProtectedGroupEvidenceSummaryV1["includedIncidents"] =
    [];
  let failureCode: string | null = null;

  for (const incidentId of includedIds) {
    try {
      const bundle = await buildAgentEvidenceBundle(prisma, workspaceId, incidentId);
      includedIncidents.push({
        incidentId,
        bundleVersion: bundle.version,
      });
    } catch (error) {
      failureCode = failureCodeFromError(error);
      break;
    }
  }

  const summary: ProtectedGroupEvidenceSummaryV1 = {
    version: 1,
    membershipVersion: claim.targetVersion,
    includedIncidentCount: includedIncidents.length,
    omittedIncidentCount,
    evidenceFormatVersion: AGENT_EVIDENCE_VERSION,
    builderVersion: EVIDENCE_PREPARATION_BUILDER_VERSION,
    includedIncidents,
    aiInvestigationPerformed: false,
  };

  const serialized = JSON.stringify(summary);
  if (
    serialized.length > INVESTIGATION_PREPARATION_LIMITS.maxProtectedSummaryUtf8Bytes
  ) {
    failureCode = "SUMMARY_SIZE_EXCEEDED";
  } else {
    const parsed = protectedGroupEvidenceSummarySchema.safeParse(summary);
    if (!parsed.success) {
      failureCode = "SUMMARY_SCHEMA_INVALID";
    }
  }

  const runStatus =
    failureCode !== null
      ? EvidencePreparationRunStatus.FAILED
      : EvidencePreparationRunStatus.EVIDENCE_READY;

  await prisma.$transaction(async (tx) => {
    const currentRun = await tx.evidencePreparationRun.findUnique({
      where: { id: claim.runId },
    });
    if (!currentRun || currentRun.claimedBy !== workerId) {
      return;
    }

    await tx.evidencePreparationRun.update({
      where: { id: claim.runId },
      data: {
        status: runStatus,
        failureCode,
        completedAt: new Date(),
        claimExpiresAt: null,
        attemptCount: { increment: 1 },
        includedIncidentCount: includedIncidents.length,
        omittedIncidentCount,
        protectedSummary:
          runStatus === EvidencePreparationRunStatus.EVIDENCE_READY
            ? (summary as Prisma.InputJsonValue)
            : undefined,
      },
    });

    if (runStatus === EvidencePreparationRunStatus.EVIDENCE_READY) {
      await tx.investigationGroup.update({
        where: { id: investigationGroupId },
        data: { preparedMembershipVersion: claim.targetVersion },
      });
      await scheduleGroupInferenceOutbox(
        tx,
        workspaceId,
        investigationGroupId,
        claim.runId,
      );
    }
  });

  const refreshed = await prisma.investigationGroup.findFirst({
    where: { id: investigationGroupId, workspaceId },
  });
  if (
    refreshed &&
    refreshed.membershipVersion > refreshed.preparedMembershipVersion
  ) {
    await prisma.$transaction(async (tx) => {
      await scheduleGroupPreparationOutbox(tx, workspaceId, investigationGroupId);
    });
  }

  return {
    status: "processed",
    runId: claim.runId,
    runStatus,
  };
}
