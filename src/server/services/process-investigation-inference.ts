import { randomUUID } from "node:crypto";
import {
  EvidencePreparationRunStatus,
  InvestigationInferenceRunStatus,
  Prisma,
  type PrismaClient,
} from "@/generated/prisma/client";
import {
  INVESTIGATION_EXPLANATION_PROMPT_SCHEMA_VERSION,
  INVESTIGATION_EXPLANATION_PROMPT_SCHEMA_VERSION_WITH_DEPLOYMENT,
  INVESTIGATION_EXPLANATION_PROMPT_SCHEMA_VERSION_WITH_DOCUMENTATION,
  INVESTIGATION_EXPLANATION_PROMPT_SCHEMA_VERSION_WITH_REPOSITORY,
  INVESTIGATION_INFERENCE_LIMITS,
  isAiInvestigationEnabledForWorkspace,
  resolveInferenceAdapterKind,
} from "@/lib/investigation/inference/config";
import { resolveInvestigationInferenceAdapter } from "@/lib/investigation/inference/resolve-adapter";
import {
  rebuildInferenceInputFromPreparationRun,
  validateInferenceInputBeforeProvider,
} from "@/lib/investigation/inference/rebuild-inference-input";
import { buildContextEnrichedInferenceInput } from "@/server/investigation/build-context-enriched-input";
import { isRetryableGatewayFailureCode } from "@/lib/investigation/inference/adapters/gateway-error-diagnostics";
import { validateExplanationOutputWithDiagnostics } from "@/lib/investigation/inference/validate-explanation-output";
import { readInferenceTokenUsage } from "@/lib/investigation/inference/explanation-rejection-diagnostics";
import { scheduleGroupInferenceOutbox } from "@/lib/investigation/schedule-outbox";

const CLAIM_TTL_MS = 90_000;

export type ProcessInvestigationInferenceResult =
  | { status: "skipped"; reason: string }
  | {
      status: "processed";
      runId: string;
      runStatus: InvestigationInferenceRunStatus;
    };

function retryableFailure(code: string): boolean {
  if (isRetryableGatewayFailureCode(code)) {
    return true;
  }
  return code === "GATEWAY_TIMEOUT" || code === "GATEWAY_REQUEST_FAILED";
}

export async function processInvestigationInference(
  prisma: PrismaClient,
  workspaceId: string,
  evidencePreparationRunId: string,
  options: {
    workerId?: string;
    repositoryContextSnapshotId?: string | null;
    documentationContextSnapshotId?: string | null;
    includeDeploymentContext?: boolean;
  } = {},
): Promise<ProcessInvestigationInferenceResult> {
  const repositoryContextSnapshotId = options.repositoryContextSnapshotId ?? null;
  const documentationContextSnapshotId = options.documentationContextSnapshotId ?? null;
  const includeDeploymentContext = options.includeDeploymentContext ?? false;

  function promptSchemaVersionForContext(): string {
    if (includeDeploymentContext) {
      return INVESTIGATION_EXPLANATION_PROMPT_SCHEMA_VERSION_WITH_DEPLOYMENT;
    }
    if (documentationContextSnapshotId) {
      return INVESTIGATION_EXPLANATION_PROMPT_SCHEMA_VERSION_WITH_DOCUMENTATION;
    }
    if (repositoryContextSnapshotId) {
      return INVESTIGATION_EXPLANATION_PROMPT_SCHEMA_VERSION_WITH_REPOSITORY;
    }
    return INVESTIGATION_EXPLANATION_PROMPT_SCHEMA_VERSION;
  }
  if (!isAiInvestigationEnabledForWorkspace(workspaceId)) {
    return { status: "skipped", reason: "ai_disabled" };
  }

  if (resolveInferenceAdapterKind() === "none") {
    return { status: "skipped", reason: "not_configured" };
  }

  const prepRun = await prisma.evidencePreparationRun.findFirst({
    where: { id: evidencePreparationRunId, workspaceId },
    include: { investigationGroup: true },
  });
  if (!prepRun) {
    return { status: "skipped", reason: "preparation_run_not_found" };
  }
  if (prepRun.status !== EvidencePreparationRunStatus.EVIDENCE_READY) {
    return { status: "skipped", reason: "preparation_not_ready" };
  }

  const workerId = options.workerId ?? `infer-${randomUUID()}`;

  const claim = await prisma.$transaction(async (tx) => {
    const existingSuccess = await tx.investigationInferenceRun.findFirst({
      where: {
        workspaceId,
        evidencePreparationRunId,
        status: InvestigationInferenceRunStatus.SUCCEEDED,
        repositoryContextSnapshotId,
        documentationContextSnapshotId,
        deploymentContextIncluded: includeDeploymentContext,
      },
    });
    if (existingSuccess) {
      return { kind: "duplicate" as const };
    }

    const stale = await tx.investigationInferenceRun.findFirst({
      where: {
        workspaceId,
        evidencePreparationRunId,
        status: InvestigationInferenceRunStatus.RUNNING,
        claimExpiresAt: { lt: new Date() },
      },
    });
    if (stale) {
      await tx.investigationInferenceRun.update({
        where: { id: stale.id },
        data: {
          status: InvestigationInferenceRunStatus.FAILED,
          failureCode: "INFERENCE_CLAIM_EXPIRED",
          completedAt: new Date(),
          claimExpiresAt: null,
          claimedAt: null,
          claimedBy: null,
        },
      });
    }

    const active = await tx.investigationInferenceRun.findFirst({
      where: {
        workspaceId,
        evidencePreparationRunId,
        status: InvestigationInferenceRunStatus.RUNNING,
        claimExpiresAt: { gte: new Date() },
      },
    });
    if (active) {
      return { kind: "busy" as const };
    }

    const runningCount = await tx.investigationInferenceRun.count({
      where: {
        status: InvestigationInferenceRunStatus.RUNNING,
        claimExpiresAt: { gte: new Date() },
      },
    });
    if (runningCount >= INVESTIGATION_INFERENCE_LIMITS.maxConcurrentRuns) {
      return { kind: "busy" as const };
    }

    const attemptsForPrep = await tx.investigationInferenceRun.count({
      where: {
        workspaceId,
        evidencePreparationRunId,
        status: { in: [InvestigationInferenceRunStatus.FAILED, InvestigationInferenceRunStatus.SUCCEEDED] },
      },
    });
    if (attemptsForPrep >= INVESTIGATION_INFERENCE_LIMITS.maxAttemptsPerPreparationRun) {
      return { kind: "exhausted" as const };
    }

    const latestGroupRun = await tx.investigationInferenceRun.findFirst({
      where: { workspaceId, investigationGroupId: prepRun.investigationGroupId },
      orderBy: { runSequence: "desc" },
    });
    const nextSequence = (latestGroupRun?.runSequence ?? 0) + 1;
    const run = await tx.investigationInferenceRun.create({
      data: {
        workspaceId,
        investigationGroupId: prepRun.investigationGroupId,
        evidencePreparationRunId,
        runSequence: nextSequence,
        membershipVersion: prepRun.membershipVersion,
        evidenceInputHash: "pending",
        promptSchemaVersion: promptSchemaVersionForContext(),
        repositoryContextSnapshotId,
        documentationContextSnapshotId,
        deploymentContextIncluded: includeDeploymentContext,
        status: InvestigationInferenceRunStatus.RUNNING,
        startedAt: new Date(),
        claimedAt: new Date(),
        claimExpiresAt: new Date(Date.now() + CLAIM_TTL_MS),
        claimedBy: workerId,
      },
    });

    return { kind: "claimed" as const, runId: run.id };
  });

  if (claim.kind === "duplicate") {
    return { status: "skipped", reason: "already_succeeded" };
  }
  if (claim.kind === "busy") {
    return { status: "skipped", reason: "run_in_progress" };
  }
  if (claim.kind === "exhausted") {
    return { status: "skipped", reason: "attempts_exhausted" };
  }

  const rebuilt = await rebuildInferenceInputFromPreparationRun(
    prisma,
    workspaceId,
    evidencePreparationRunId,
  );
  if (!rebuilt.ok) {
    await finalizeRun(prisma, claim.runId, workerId, {
      status: InvestigationInferenceRunStatus.FAILED,
      failureCode: rebuilt.code,
    });
    return {
      status: "processed",
      runId: claim.runId,
      runStatus: InvestigationInferenceRunStatus.FAILED,
    };
  }

  const modelInputResult = await buildContextEnrichedInferenceInput(
    prisma,
    workspaceId,
    prepRun.investigationGroup,
    rebuilt.input,
    rebuilt.inputHash,
    {
      repositoryContextSnapshotId,
      documentationContextSnapshotId,
      includeDeploymentContext,
      investigationGroupId: prepRun.investigationGroupId,
    },
  );
  if (!modelInputResult.ok) {
    await finalizeRun(prisma, claim.runId, workerId, {
      status: InvestigationInferenceRunStatus.FAILED,
      failureCode: modelInputResult.code,
      counts: {
        included: rebuilt.includedEvidenceCount,
        unavailable: rebuilt.unavailableEvidenceCount,
        omitted: rebuilt.omittedEvidenceCount,
      },
      evidenceInputHash: rebuilt.inputHash,
      repositoryContextSnapshotId,
      documentationContextSnapshotId,
    });
    return {
      status: "processed",
      runId: claim.runId,
      runStatus: InvestigationInferenceRunStatus.FAILED,
    };
  }

  const inputCheck = validateInferenceInputBeforeProvider(modelInputResult.input);
  if (!inputCheck.ok) {
    await finalizeRun(prisma, claim.runId, workerId, {
      status: InvestigationInferenceRunStatus.FAILED,
      failureCode: inputCheck.code,
      counts: {
        included: rebuilt.includedEvidenceCount,
        unavailable: rebuilt.unavailableEvidenceCount,
        omitted: rebuilt.omittedEvidenceCount,
      },
      evidenceInputHash: modelInputResult.inputHash,
      repositoryContextSnapshotId,
      documentationContextSnapshotId,
      repositoryExcerptRefs: modelInputResult.repositoryExcerptRefs,
      documentationExcerptRefs: modelInputResult.documentationExcerptRefs,
      deploymentEvidenceRefs: modelInputResult.deploymentEvidenceRefs,
      deploymentContextFingerprint: modelInputResult.deploymentContextFingerprint,
      deploymentContextIncluded: includeDeploymentContext,
    });
    return {
      status: "processed",
      runId: claim.runId,
      runStatus: InvestigationInferenceRunStatus.FAILED,
    };
  }

  const { adapter } = resolveInvestigationInferenceAdapter();
  const providerResult = await adapter.complete(modelInputResult.input);

  if (!providerResult.ok) {
    const retryable = providerResult.retryable ?? retryableFailure(providerResult.code);
    await finalizeRun(prisma, claim.runId, workerId, {
      status: InvestigationInferenceRunStatus.FAILED,
      failureCode: providerResult.code,
      counts: {
        included: rebuilt.includedEvidenceCount,
        unavailable: rebuilt.unavailableEvidenceCount,
        omitted: rebuilt.omittedEvidenceCount,
      },
      evidenceInputHash: modelInputResult.inputHash,
      repositoryContextSnapshotId,
      repositoryExcerptRefs: modelInputResult.repositoryExcerptRefs,
      documentationContextSnapshotId,
      documentationExcerptRefs: modelInputResult.documentationExcerptRefs,
      deploymentEvidenceRefs: modelInputResult.deploymentEvidenceRefs,
      deploymentContextFingerprint: modelInputResult.deploymentContextFingerprint,
      deploymentContextIncluded: includeDeploymentContext,
      provider: adapter.providerLabel,
      model: adapter.modelLabel,
      usageMetadata: providerResult.diagnostics
        ? { gatewayErrorDiagnostics: providerResult.diagnostics }
        : null,
      retryable,
    });
    if (retryable) {
      const failedRun = await prisma.investigationInferenceRun.findUnique({
        where: { id: claim.runId },
      });
      if (
        failedRun &&
        failedRun.attemptCount < INVESTIGATION_INFERENCE_LIMITS.maxAttemptsPerPreparationRun
      ) {
        await prisma.$transaction(async (tx) => {
          await scheduleGroupInferenceOutbox(
            tx,
            workspaceId,
            prepRun.investigationGroupId,
            evidencePreparationRunId,
          );
        });
      }
    }
    return {
      status: "processed",
      runId: claim.runId,
      runStatus: InvestigationInferenceRunStatus.FAILED,
    };
  }

  const validated = validateExplanationOutputWithDiagnostics(providerResult.rawJson, modelInputResult.input, { requireStructuredSources: providerResult.outputContract === "source-facts-v2" });
  if (!validated.ok) {
    await finalizeRun(prisma, claim.runId, workerId, {
      status: InvestigationInferenceRunStatus.FAILED,
      failureCode: validated.code,
      usageMetadata: { ...readInferenceTokenUsage(providerResult.usage), explanationRejection: validated.diagnostic },
      counts: {
        included: rebuilt.includedEvidenceCount,
        unavailable: rebuilt.unavailableEvidenceCount,
        omitted: rebuilt.omittedEvidenceCount,
      },
      evidenceInputHash: modelInputResult.inputHash,
      repositoryContextSnapshotId,
      repositoryExcerptRefs: modelInputResult.repositoryExcerptRefs,
      documentationContextSnapshotId,
      documentationExcerptRefs: modelInputResult.documentationExcerptRefs,
      deploymentEvidenceRefs: modelInputResult.deploymentEvidenceRefs,
      deploymentContextFingerprint: modelInputResult.deploymentContextFingerprint,
      deploymentContextIncluded: includeDeploymentContext,
      provider: providerResult.provider,
      model: providerResult.model,
      retryable: false,
    });
    return {
      status: "processed",
      runId: claim.runId,
      runStatus: InvestigationInferenceRunStatus.FAILED,
    };
  }

  await finalizeRun(prisma, claim.runId, workerId, {
    status: InvestigationInferenceRunStatus.SUCCEEDED,
    failureCode: null,
    counts: {
      included: rebuilt.includedEvidenceCount,
      unavailable: rebuilt.unavailableEvidenceCount,
      omitted: rebuilt.omittedEvidenceCount,
    },
    evidenceInputHash: modelInputResult.inputHash,
    repositoryContextSnapshotId,
    repositoryExcerptRefs: modelInputResult.repositoryExcerptRefs,
    documentationContextSnapshotId,
    documentationExcerptRefs: modelInputResult.documentationExcerptRefs,
    deploymentEvidenceRefs: modelInputResult.deploymentEvidenceRefs,
    deploymentContextFingerprint: modelInputResult.deploymentContextFingerprint,
    deploymentContextIncluded: includeDeploymentContext,
    provider: providerResult.provider,
    model: providerResult.model,
    validatedOutput: validated.output,
    usageMetadata: providerResult.usage ?? null,
  });

  const group = await prisma.investigationGroup.findFirst({
    where: { id: prepRun.investigationGroupId, workspaceId },
  });
  if (group && group.membershipVersion >= prepRun.membershipVersion) {
    await prisma.investigationGroup.update({
      where: { id: prepRun.investigationGroupId },
      data: {
        inferredMembershipVersion: prepRun.membershipVersion,
      },
    });
  }

  return {
    status: "processed",
    runId: claim.runId,
    runStatus: InvestigationInferenceRunStatus.SUCCEEDED,
  };
}

async function finalizeRun(
  prisma: PrismaClient,
  runId: string,
  workerId: string,
  input: {
    status: InvestigationInferenceRunStatus;
    failureCode: string | null;
    evidenceInputHash?: string;
    repositoryContextSnapshotId?: string | null;
    repositoryExcerptRefs?: Array<{
      id: string;
      relativeFilePath: string;
      startLine: number;
      endLine: number;
    }>;
    documentationContextSnapshotId?: string | null;
    documentationExcerptRefs?: Array<{
      id: string;
      documentId: string;
      sectionHeading: string;
      startLine: number;
      endLine: number;
    }>;
    deploymentEvidenceRefs?: Array<{
      id: string;
      deploymentRecordId: string;
      sourceReportedAt: string;
      status: string;
    }>;
    deploymentContextFingerprint?: string | null;
    deploymentContextIncluded?: boolean;
    counts?: { included: number; unavailable: number; omitted: number };
    provider?: string;
    model?: string;
    validatedOutput?: unknown;
    usageMetadata?: Record<string, unknown> | null;
    retryable?: boolean;
  },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const current = await tx.investigationInferenceRun.findUnique({ where: { id: runId } });
    if (!current || current.claimedBy !== workerId) {
      return;
    }

    await tx.investigationInferenceRun.update({
      where: { id: runId },
      data: {
        status: input.status,
        failureCode: input.failureCode,
        evidenceInputHash: input.evidenceInputHash ?? current.evidenceInputHash,
        repositoryContextSnapshotId:
          input.repositoryContextSnapshotId !== undefined
            ? input.repositoryContextSnapshotId
            : current.repositoryContextSnapshotId,
        repositoryExcerptRefs:
          input.repositoryExcerptRefs !== undefined
            ? (input.repositoryExcerptRefs as Prisma.InputJsonValue)
            : undefined,
        documentationContextSnapshotId:
          input.documentationContextSnapshotId !== undefined
            ? input.documentationContextSnapshotId
            : current.documentationContextSnapshotId,
        documentationExcerptRefs:
          input.documentationExcerptRefs !== undefined
            ? (input.documentationExcerptRefs as Prisma.InputJsonValue)
            : undefined,
        deploymentEvidenceRefs:
          input.deploymentEvidenceRefs !== undefined
            ? (input.deploymentEvidenceRefs as Prisma.InputJsonValue)
            : undefined,
        deploymentContextFingerprint:
          input.deploymentContextFingerprint !== undefined
            ? input.deploymentContextFingerprint
            : current.deploymentContextFingerprint,
        deploymentContextIncluded:
          input.deploymentContextIncluded !== undefined
            ? input.deploymentContextIncluded
            : current.deploymentContextIncluded,
        includedEvidenceCount: input.counts?.included ?? current.includedEvidenceCount,
        unavailableEvidenceCount: input.counts?.unavailable ?? current.unavailableEvidenceCount,
        omittedEvidenceCount: input.counts?.omitted ?? current.omittedEvidenceCount,
        provider: input.provider ?? current.provider,
        model: input.model ?? current.model,
        validatedOutput:
          input.validatedOutput !== undefined
            ? (input.validatedOutput as Prisma.InputJsonValue)
            : undefined,
        usageMetadata:
          input.usageMetadata !== undefined
            ? (input.usageMetadata as Prisma.InputJsonValue)
            : undefined,
        completedAt: new Date(),
        claimExpiresAt: null,
        attemptCount: { increment: 1 },
      },
    });
  });
}
