import { createHash } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { INVESTIGATION_INFERENCE_LIMITS } from "@/lib/investigation/inference/config";
import { jsonUtf8ByteLength } from "@/lib/investigation/inference/utf8-byte-length";
import { DEPLOYMENT_CONTEXT_LIMITS } from "@/lib/deployment-context/config";
import {
  attachRepositoryContextToInferenceInput,
  fieldTokensFromInput,
  type InvestigationDeploymentContextBlockV1,
  type InvestigationDocumentationContextBlockV1,
  type InvestigationModelInput,
  type InvestigationModelInputV1,
  type InvestigationRepositoryContextBlockV1,
} from "@/lib/investigation/inference/rebuild-inference-input";
import { retrieveDocumentationExcerptsForSnapshot } from "@/server/documentation-context/retrieve-excerpts";
import { retrieveDeploymentEvidence } from "@/server/deployment-context/retrieve-evidence";
import { retrieveRepositoryExcerptsForSnapshot } from "@/server/repository-context/retrieve-excerpts";

export type ContextEnrichmentOptions = {
  repositoryContextSnapshotId?: string | null;
  documentationContextSnapshotId?: string | null;
  includeDeploymentContext?: boolean;
  investigationGroupId: string;
};

export type ContextEnrichmentResult =
  | {
      ok: true;
      input: InvestigationModelInput;
      inputHash: string;
      repositoryExcerptRefs: Array<{
        id: string;
        relativeFilePath: string;
        startLine: number;
        endLine: number;
      }>;
      documentationExcerptRefs: Array<{
        id: string;
        documentId: string;
        sectionHeading: string;
        startLine: number;
        endLine: number;
      }>;
      deploymentEvidenceRefs: Array<{
        id: string;
        deploymentRecordId: string;
        sourceReportedAt: string;
        status: string;
      }>;
      deploymentContextFingerprint: string | null;
      usesDocumentation: boolean;
      usesRepository: boolean;
      usesDeployment: boolean;
    }
  | { ok: false; code: string };

async function incidentReferenceTimes(
  prisma: PrismaClient,
  workspaceId: string,
  investigationGroupId: string,
): Promise<{ referenceOccurredAt: Date; earliestIncidentReceivedAt: Date } | null> {
  const memberships = await prisma.investigationGroupMembership.findMany({
    where: { workspaceId, investigationGroupId },
    include: { incident: { select: { occurredAt: true, receivedAt: true } } },
  });
  if (memberships.length === 0) {
    return null;
  }
  let referenceOccurredAt = memberships[0]!.incident.occurredAt;
  let earliestIncidentReceivedAt = memberships[0]!.incident.receivedAt;
  for (const row of memberships) {
    if (row.incident.occurredAt.getTime() < referenceOccurredAt.getTime()) {
      referenceOccurredAt = row.incident.occurredAt;
    }
    if (row.incident.receivedAt.getTime() < earliestIncidentReceivedAt.getTime()) {
      earliestIncidentReceivedAt = row.incident.receivedAt;
    }
  }
  return { referenceOccurredAt, earliestIncidentReceivedAt };
}

function toV3Input(
  base: InvestigationModelInputV1,
  repositoryContext?: InvestigationRepositoryContextBlockV1,
  documentationContext?: InvestigationDocumentationContextBlockV1,
) {
  return {
    ...base,
    version: 3 as const,
    ...(repositoryContext ? { repositoryContext } : {}),
    ...(documentationContext ? { documentationContext } : {}),
  };
}

function toV4Input(
  base: InvestigationModelInputV1,
  repositoryContext?: InvestigationRepositoryContextBlockV1,
  documentationContext?: InvestigationDocumentationContextBlockV1,
  deploymentContext?: InvestigationDeploymentContextBlockV1,
) {
  return {
    ...base,
    version: 4 as const,
    ...(repositoryContext ? { repositoryContext } : {}),
    ...(documentationContext ? { documentationContext } : {}),
    ...(deploymentContext ? { deploymentContext } : {}),
  };
}

export async function buildContextEnrichedInferenceInput(
  prisma: PrismaClient,
  workspaceId: string,
  group: {
    apiKey: string;
    environment: string;
    httpMethod: string;
    operationIdentity: string;
    apiSpecId: string | null;
  },
  baseInput: InvestigationModelInputV1,
  baseHash: string,
  options: ContextEnrichmentOptions,
): Promise<ContextEnrichmentResult> {
  const repositoryContextSnapshotId = options.repositoryContextSnapshotId ?? null;
  const documentationContextSnapshotId = options.documentationContextSnapshotId ?? null;
  const includeDeploymentContext = options.includeDeploymentContext ?? false;

  if (!repositoryContextSnapshotId && !documentationContextSnapshotId && !includeDeploymentContext) {
    return {
      ok: true,
      input: baseInput,
      inputHash: baseHash,
      repositoryExcerptRefs: [],
      documentationExcerptRefs: [],
      deploymentEvidenceRefs: [],
      deploymentContextFingerprint: null,
      usesDocumentation: false,
      usesRepository: false,
      usesDeployment: false,
    };
  }

  const operationPath = group.operationIdentity.startsWith("__operation_unresolved__")
    ? null
    : group.operationIdentity;
  const fieldTokens = fieldTokensFromInput(baseInput);

  let repositoryContext: InvestigationRepositoryContextBlockV1 | undefined;
  const repositoryExcerptRefs: Array<{
    id: string;
    relativeFilePath: string;
    startLine: number;
    endLine: number;
  }> = [];

  if (repositoryContextSnapshotId) {
    const retrieved = await retrieveRepositoryExcerptsForSnapshot(prisma, repositoryContextSnapshotId, {
      workspaceId,
      apiKey: group.apiKey,
      environment: group.environment,
      httpMethod: group.httpMethod,
      operationPath,
      fieldTokens,
    });
    if (!retrieved.ok) {
      return { ok: false, code: retrieved.code };
    }
    const snapshot = await prisma.repositoryContextSnapshot.findFirst({
      where: { id: repositoryContextSnapshotId, workspaceId },
    });
    if (!snapshot) {
      return { ok: false, code: "SNAPSHOT_NOT_FOUND" };
    }
    repositoryContext = {
      snapshotId: snapshot.id,
      repository: snapshot.repository,
      commitSha: snapshot.commitSha,
      deploymentRelationship: "unknown",
      excerpts: retrieved.excerpts.map((row) => ({
        id: row.id,
        relativeFilePath: row.relativeFilePath,
        startLine: row.startLine,
        endLine: row.endLine,
        sanitizedExcerpt: row.sanitizedExcerpt,
        retrievalMethod: row.retrievalMethod,
        limitations: row.limitations,
      })),
      missingContext: retrieved.missingContext,
      limitations: retrieved.limitations,
    };
    for (const row of retrieved.excerpts) {
      repositoryExcerptRefs.push({
        id: row.id,
        relativeFilePath: row.relativeFilePath,
        startLine: row.startLine,
        endLine: row.endLine,
      });
    }
  }

  let documentationContext: InvestigationDocumentationContextBlockV1 | undefined;
  const documentationExcerptRefs: Array<{
    id: string;
    documentId: string;
    sectionHeading: string;
    startLine: number;
    endLine: number;
  }> = [];

  if (documentationContextSnapshotId) {
    const retrieved = await retrieveDocumentationExcerptsForSnapshot(
      prisma,
      documentationContextSnapshotId,
      {
        workspaceId,
        apiKey: group.apiKey,
        environment: group.environment,
        httpMethod: group.httpMethod,
        operationPath,
        pinnedApiSpecId: group.apiSpecId,
        fieldTokens,
      },
    );
    if (!retrieved.ok) {
      return { ok: false, code: retrieved.code };
    }
    const snapshot = await prisma.documentationContextSnapshot.findFirst({
      where: { id: documentationContextSnapshotId, workspaceId },
    });
    if (!snapshot) {
      return { ok: false, code: "DOCUMENTATION_SNAPSHOT_NOT_FOUND" };
    }
    documentationContext = {
      snapshotId: snapshot.id,
      sourceKey: snapshot.sourceKey,
      importedAt: snapshot.createdAt.toISOString(),
      excerpts: retrieved.excerpts.map((row) => ({
        id: row.id,
        documentId: row.documentId,
        title: row.title,
        contentSha256: row.contentSha256,
        contentVersion: row.contentVersion,
        sectionHeading: row.sectionHeading,
        startLine: row.startLine,
        endLine: row.endLine,
        sanitizedExcerpt: row.sanitizedExcerpt,
        applicability: row.applicability,
        retrievalMethod: row.retrievalMethod,
        limitations: row.limitations,
        trustedSourceUrl: row.trustedSourceUrl,
      })),
      missingContext: retrieved.missingContext,
      limitations: retrieved.limitations,
    };
    for (const row of retrieved.excerpts) {
      documentationExcerptRefs.push({
        id: row.id,
        documentId: row.documentId,
        sectionHeading: row.sectionHeading,
        startLine: row.startLine,
        endLine: row.endLine,
      });
    }
  }

  let deploymentContext: InvestigationDeploymentContextBlockV1 | undefined;
  const deploymentEvidenceRefs: Array<{
    id: string;
    deploymentRecordId: string;
    sourceReportedAt: string;
    status: string;
  }> = [];
  let deploymentContextFingerprint: string | null = null;

  if (includeDeploymentContext) {
    const times = await incidentReferenceTimes(prisma, workspaceId, options.investigationGroupId);
    if (!times) {
      return { ok: false, code: "NO_INCIDENT_REFERENCE_TIME" };
    }
    let repositorySnapshotCommitSha: string | null = null;
    if (repositoryContextSnapshotId) {
      const repoSnap = await prisma.repositoryContextSnapshot.findFirst({
        where: { id: repositoryContextSnapshotId, workspaceId },
      });
      repositorySnapshotCommitSha = repoSnap?.commitSha ?? null;
    }
    const retrieved = await retrieveDeploymentEvidence(prisma, {
      workspaceId,
      apiKey: group.apiKey,
      environment: group.environment,
      referenceOccurredAt: times.referenceOccurredAt,
      earliestIncidentReceivedAt: times.earliestIncidentReceivedAt,
      repositorySnapshotCommitSha,
    });
    if (!retrieved.ok) {
      return { ok: false, code: retrieved.code };
    }
    deploymentContextFingerprint = retrieved.fingerprint;
    deploymentContext = {
      referenceOccurredAt: times.referenceOccurredAt.toISOString(),
      lookbackMs: DEPLOYMENT_CONTEXT_LIMITS.lookbackBeforeReferenceMs,
      records: retrieved.items.map((row) => ({
        id: row.id,
        sourceDeploymentRef: row.sourceDeploymentRef,
        status: row.status,
        sourceReportedAt: row.sourceReportedAt,
        receivedAt: row.receivedAt,
        repository: row.repository,
        commitSha: row.commitSha,
        artifactRef: row.artifactRef,
        apiSpecId: row.apiSpecId,
        runningVersionAssessment: row.runningVersionAssessment,
        repositoryCommitMatch: row.repositoryCommitMatch,
        retrievalMethod: row.retrievalMethod,
        limitations: row.limitations,
      })),
      missingContext: retrieved.missingContext,
      limitations: retrieved.limitations,
    };
    for (const row of retrieved.items) {
      deploymentEvidenceRefs.push({
        id: row.id,
        deploymentRecordId: row.deploymentRecordId,
        sourceReportedAt: row.sourceReportedAt,
        status: row.status,
      });
    }
  }

  let input: InvestigationModelInput;
  if (includeDeploymentContext) {
    input = toV4Input(baseInput, repositoryContext, documentationContext, deploymentContext);
  } else if (documentationContextSnapshotId) {
    input = toV3Input(baseInput, repositoryContext, documentationContext);
  } else if (repositoryContext) {
    input = attachRepositoryContextToInferenceInput(baseInput, repositoryContext);
  } else {
    input = baseInput;
  }

  const serialized = JSON.stringify(input);
  if (jsonUtf8ByteLength(input) > INVESTIGATION_INFERENCE_LIMITS.maxEvidenceInputUtf8Bytes) {
    return { ok: false, code: "EVIDENCE_INPUT_SIZE_EXCEEDED" };
  }

  const inputHash = createHash("sha256").update(serialized, "utf8").digest("hex");
  return {
    ok: true,
    input,
    inputHash,
    repositoryExcerptRefs,
    documentationExcerptRefs,
    deploymentEvidenceRefs,
    deploymentContextFingerprint,
    usesDocumentation: Boolean(documentationContextSnapshotId),
    usesRepository: Boolean(repositoryContextSnapshotId),
    usesDeployment: includeDeploymentContext,
  };
}
