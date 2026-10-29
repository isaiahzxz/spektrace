import {
  EvidencePreparationRunStatus,
  InvestigationInferenceRunStatus,
  type PrismaClient,
} from "@/generated/prisma/client";
import { isAiInvestigationEnabledForWorkspace } from "@/lib/investigation/inference/config";
import { processInvestigationInference } from "@/server/services/process-investigation-inference";

export type RequestInferenceWithContextInput = {
  workspaceId: string;
  investigationGroupId: string;
  evidencePreparationRunId?: string;
  repositoryContextSnapshotId?: string;
  documentationContextSnapshotId?: string;
  includeDeploymentContext?: boolean;
};

export type RequestInferenceWithContextResult =
  | { ok: true; inferenceRunId: string; runStatus: InvestigationInferenceRunStatus }
  | { ok: false; code: string; message: string };

export async function requestInferenceWithContext(
  prisma: PrismaClient,
  input: RequestInferenceWithContextInput,
): Promise<RequestInferenceWithContextResult> {
  if (!isAiInvestigationEnabledForWorkspace(input.workspaceId)) {
    return { ok: false, code: "AI_DISABLED", message: "AI investigation is disabled for this workspace." };
  }

  if (
    !input.repositoryContextSnapshotId &&
    !input.documentationContextSnapshotId &&
    !input.includeDeploymentContext
  ) {
    return {
      ok: false,
      code: "NO_CONTEXT_SELECTED",
      message: "Select at least one approved repository, documentation, or deployment context.",
    };
  }

  const group = await prisma.investigationGroup.findFirst({
    where: { id: input.investigationGroupId, workspaceId: input.workspaceId },
  });
  if (!group) {
    return { ok: false, code: "GROUP_NOT_FOUND", message: "Investigation group was not found." };
  }

  if (input.repositoryContextSnapshotId) {
    const repositorySnapshot = await prisma.repositoryContextSnapshot.findFirst({
      where: { id: input.repositoryContextSnapshotId, workspaceId: input.workspaceId },
    });
    if (!repositorySnapshot) {
      return { ok: false, code: "SNAPSHOT_NOT_FOUND", message: "Repository snapshot was not found." };
    }
    if (repositorySnapshot.apiKey !== group.apiKey || repositorySnapshot.environment !== group.environment) {
      return {
        ok: false,
        code: "SNAPSHOT_SERVICE_MISMATCH",
        message: "Repository snapshot service mapping does not match the investigation group.",
      };
    }
  }

  if (input.documentationContextSnapshotId) {
    const documentationSnapshot = await prisma.documentationContextSnapshot.findFirst({
      where: { id: input.documentationContextSnapshotId, workspaceId: input.workspaceId },
    });
    if (!documentationSnapshot) {
      return {
        ok: false,
        code: "DOCUMENTATION_SNAPSHOT_NOT_FOUND",
        message: "Documentation snapshot was not found.",
      };
    }
    if (
      documentationSnapshot.apiKey !== group.apiKey ||
      documentationSnapshot.environment !== group.environment
    ) {
      return {
        ok: false,
        code: "DOCUMENTATION_SCOPE_MISMATCH",
        message: "Documentation snapshot scope does not match the investigation group.",
      };
    }
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

  const processed = await processInvestigationInference(prisma, input.workspaceId, prep.id, {
    repositoryContextSnapshotId: input.repositoryContextSnapshotId ?? null,
    documentationContextSnapshotId: input.documentationContextSnapshotId ?? null,
    includeDeploymentContext: input.includeDeploymentContext ?? false,
  });

  if (processed.status === "skipped") {
    return {
      ok: false,
      code: "INFERENCE_SKIPPED",
      message: `Inference was not started (${processed.reason}).`,
    };
  }

  const run = await prisma.investigationInferenceRun.findUnique({ where: { id: processed.runId } });
  return {
    ok: true,
    inferenceRunId: processed.runId,
    runStatus: run?.status ?? processed.runStatus,
  };
}
