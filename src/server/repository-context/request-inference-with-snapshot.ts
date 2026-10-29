import {
  EvidencePreparationRunStatus,
  InvestigationInferenceRunStatus,
  type PrismaClient,
} from "@/generated/prisma/client";
import { isAiInvestigationEnabledForWorkspace } from "@/lib/investigation/inference/config";
import { requestInferenceWithContext } from "@/server/investigation/request-inference-with-context";

export type RequestInferenceWithRepositorySnapshotInput = {
  workspaceId: string;
  investigationGroupId: string;
  repositoryContextSnapshotId: string;
  evidencePreparationRunId?: string;
};

export type RequestInferenceWithRepositorySnapshotResult =
  | { ok: true; inferenceRunId: string; runStatus: InvestigationInferenceRunStatus }
  | { ok: false; code: string; message: string };

export async function requestInferenceWithRepositorySnapshot(
  prisma: PrismaClient,
  input: RequestInferenceWithRepositorySnapshotInput,
): Promise<RequestInferenceWithRepositorySnapshotResult> {
  if (!isAiInvestigationEnabledForWorkspace(input.workspaceId)) {
    return { ok: false, code: "AI_DISABLED", message: "AI investigation is disabled for this workspace." };
  }

  const group = await prisma.investigationGroup.findFirst({
    where: { id: input.investigationGroupId, workspaceId: input.workspaceId },
  });
  if (!group) {
    return { ok: false, code: "GROUP_NOT_FOUND", message: "Investigation group was not found." };
  }

  const snapshot = await prisma.repositoryContextSnapshot.findFirst({
    where: { id: input.repositoryContextSnapshotId, workspaceId: input.workspaceId },
  });
  if (!snapshot) {
    return { ok: false, code: "SNAPSHOT_NOT_FOUND", message: "Repository snapshot was not found." };
  }
  if (snapshot.apiKey !== group.apiKey || snapshot.environment !== group.environment) {
    return {
      ok: false,
      code: "SNAPSHOT_SERVICE_MISMATCH",
      message: "Repository snapshot service mapping does not match the investigation group.",
    };
  }

  let preparationRunId = input.evidencePreparationRunId;
  if (!preparationRunId) {
    const latest = await prisma.evidencePreparationRun.findFirst({
      where: {
        workspaceId: input.workspaceId,
        investigationGroupId: group.id,
        status: EvidencePreparationRunStatus.EVIDENCE_READY,
      },
      orderBy: { runSequence: "desc" },
    });
    if (!latest) {
      return {
        ok: false,
        code: "PREPARATION_NOT_READY",
        message: "No evidence-ready preparation run exists for this group.",
      };
    }
    preparationRunId = latest.id;
  }

  const prep = await prisma.evidencePreparationRun.findFirst({
    where: {
      id: preparationRunId,
      workspaceId: input.workspaceId,
      investigationGroupId: group.id,
      status: EvidencePreparationRunStatus.EVIDENCE_READY,
    },
  });
  if (!prep) {
    return {
      ok: false,
      code: "PREPARATION_NOT_READY",
      message: "The selected preparation run is not evidence-ready for this group.",
    };
  }

  return requestInferenceWithContext(prisma, {
    workspaceId: input.workspaceId,
    investigationGroupId: input.investigationGroupId,
    evidencePreparationRunId: prep.id,
    repositoryContextSnapshotId: input.repositoryContextSnapshotId,
  });
}
