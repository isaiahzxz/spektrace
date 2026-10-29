import "server-only";
import {
  EvidencePreparationRunStatus,
  InvestigationInferenceRunStatus,
  OutboxEventType,
  type PrismaClient,
} from "@/generated/prisma/client";
import {
  INVESTIGATION_EXPLANATION_PROMPT_SCHEMA_VERSION,
  isAiInvestigationEnabledForWorkspace,
  resolveInferenceAdapterKind,
} from "@/lib/investigation/inference/config";
import type { InvestigationExplanationOutputV1 } from "@/lib/investigation/inference/explanation-output-v1";
import { investigationExplanationOutputSchema } from "@/lib/investigation/inference/explanation-output-v1";
import {
  DOCUMENTATION_AUTHORITY_NOTE,
  DOCUMENTATION_FRESHNESS_NOTE,
} from "@/lib/documentation-context/config";
import { DEPLOYMENT_TEMPORAL_NOTE } from "@/lib/deployment-context/config";
import { opaqueDeploymentRef } from "@/server/deployment-context/retrieve-evidence";
import { DEPLOYMENT_RELATIONSHIP_UNKNOWN } from "@/server/repository-context/retrieve-excerpts";

export type DocumentationCitationView = {
  id: string;
  title: string;
  documentId: string;
  section: string;
  contentVersion: string | null;
  contentSha256: string;
  startLine: number;
  endLine: number;
  excerpt: string;
  applicabilityNote: string;
  trustedSourceUrl: string | null;
};

export type DeploymentCitationView = {
  id: string;
  status: string;
  service: string;
  environment: string;
  sourceReportedAt: string;
  receivedAt: string;
  commitSha: string | null;
  artifactRef: string | null;
  sourceDeploymentRef: string;
  relationshipNote: string;
  uncertaintyNote: string;
};

export type RepositoryCitationView = {
  id: string;
  file: string;
  commitSha: string;
  repository: string;
  startLine: number;
  endLine: number;
  excerpt: string;
  deploymentRelationship: "unknown";
  deploymentRelationshipNote: string;
};

export type IncidentAiExplanationView =
  | { state: "disabled" }
  | { state: "not-configured" }
  | { state: "not-grouped" }
  | { state: "preparing" }
  | { state: "queued" }
  | { state: "running" }
  | { state: "failed"; failureCode: string | null; membershipVersion: number | null }
  | {
      state: "available";
      label: "AI explanation";
      membershipVersion: number;
      evidenceInputHash: string;
      promptSchemaVersion: string;
      groupedIncidentCount: number;
      includedEvidenceCount: number;
      unavailableEvidenceCount: number;
      omittedEvidenceCount: number;
      newerEvidenceAvailable: boolean;
      output: InvestigationExplanationOutputV1;
      provider: string | null;
      model: string | null;
      generatedAt: string | null;
      repositoryCitations: RepositoryCitationView[];
      documentationCitations: DocumentationCitationView[];
      deploymentCitations: DeploymentCitationView[];
    };

export async function loadIncidentAiExplanation(
  prisma: PrismaClient,
  workspaceId: string,
  incidentId: string,
): Promise<IncidentAiExplanationView> {
  if (!isAiInvestigationEnabledForWorkspace(workspaceId)) {
    return { state: "disabled" };
  }
  if (resolveInferenceAdapterKind() === "none") {
    return { state: "not-configured" };
  }

  const membership = await prisma.investigationGroupMembership.findFirst({
    where: { workspaceId, incidentId },
    include: { investigationGroup: true },
  });
  if (!membership) {
    return { state: "not-grouped" };
  }

  const group = membership.investigationGroup;
  const latestReadyPrep = await prisma.evidencePreparationRun.findFirst({
    where: {
      workspaceId,
      investigationGroupId: group.id,
      status: EvidencePreparationRunStatus.EVIDENCE_READY,
    },
    orderBy: { runSequence: "desc" },
  });

  if (!latestReadyPrep) {
    return { state: "preparing" };
  }

  let inference = await prisma.investigationInferenceRun.findFirst({
    where: {
      workspaceId,
      evidencePreparationRunId: latestReadyPrep.id,
      status: InvestigationInferenceRunStatus.SUCCEEDED,
    },
    orderBy: { runSequence: "desc" },
  });

  if (!inference) {
    inference = await prisma.investigationInferenceRun.findFirst({
      where: { workspaceId, evidencePreparationRunId: latestReadyPrep.id },
      orderBy: { runSequence: "desc" },
    });
  }

  if (!inference) {
    const priorSuccess = await prisma.investigationInferenceRun.findFirst({
      where: {
        workspaceId,
        investigationGroupId: group.id,
        status: InvestigationInferenceRunStatus.SUCCEEDED,
      },
      orderBy: { completedAt: "desc" },
    });
    if (priorSuccess) {
      inference = priorSuccess;
    }
  }

  const latestPrep = latestReadyPrep;

  const pendingOutbox = await prisma.outboxEvent.findFirst({
    where: {
      workspaceId,
      evidencePreparationRunId: latestPrep.id,
      eventType: OutboxEventType.INVESTIGATION_GROUP_INFERENCE_REQUESTED,
      dispatchStatus: { in: ["PENDING", "CLAIMED"] },
    },
  });

  if (!inference) {
    return pendingOutbox ? { state: "queued" } : { state: "queued" };
  }

  if (inference.status === InvestigationInferenceRunStatus.RUNNING) {
    return { state: "running" };
  }

  if (inference.status === InvestigationInferenceRunStatus.FAILED) {
    return {
      state: "failed",
      failureCode: inference.failureCode,
      membershipVersion: inference.membershipVersion,
    };
  }

  if (inference.status !== InvestigationInferenceRunStatus.SUCCEEDED || !inference.validatedOutput) {
    return { state: "failed", failureCode: inference.failureCode, membershipVersion: inference.membershipVersion };
  }

  const parsed = investigationExplanationOutputSchema.safeParse(inference.validatedOutput);
  if (!parsed.success) {
    return { state: "failed", failureCode: "STORED_OUTPUT_INVALID", membershipVersion: inference.membershipVersion };
  }

  const summary = latestPrep.protectedSummary as {
    includedIncidentCount?: number;
    omittedIncidentCount?: number;
  } | null;
  const groupedIncidentCount =
    (summary?.includedIncidentCount ?? inference.includedEvidenceCount) +
    (summary?.omittedIncidentCount ?? inference.omittedEvidenceCount);

  const newerEvidenceAvailable =
    group.membershipVersion > inference.membershipVersion ||
    latestPrep.id !== inference.evidencePreparationRunId ||
    latestPrep.membershipVersion > inference.membershipVersion;

  const repositoryCitations = await loadRepositoryCitations(
    prisma,
    workspaceId,
    inference.repositoryExcerptRefs,
    inference.repositoryContextSnapshotId,
  );
  const documentationCitations = await loadDocumentationCitations(
    prisma,
    workspaceId,
    inference.documentationExcerptRefs,
    inference.documentationContextSnapshotId,
  );
  const deploymentCitations = await loadDeploymentCitations(
    prisma,
    workspaceId,
    inference.deploymentEvidenceRefs,
    inference.deploymentContextIncluded,
  );

  return {
    state: "available",
    label: "AI explanation",
    membershipVersion: inference.membershipVersion,
    evidenceInputHash: inference.evidenceInputHash,
    promptSchemaVersion: inference.promptSchemaVersion || INVESTIGATION_EXPLANATION_PROMPT_SCHEMA_VERSION,
    groupedIncidentCount,
    includedEvidenceCount: inference.includedEvidenceCount,
    unavailableEvidenceCount: inference.unavailableEvidenceCount,
    omittedEvidenceCount: inference.omittedEvidenceCount,
    newerEvidenceAvailable,
    output: parsed.data,
    provider: inference.provider,
    model: inference.model,
    generatedAt: inference.completedAt?.toISOString() ?? null,
    repositoryCitations,
    documentationCitations,
    deploymentCitations,
  };
}

type StoredExcerptRef = {
  id: string;
  relativeFilePath: string;
  startLine: number;
  endLine: number;
};

async function loadRepositoryCitations(
  prisma: PrismaClient,
  workspaceId: string,
  excerptRefs: unknown,
  snapshotId: string | null,
): Promise<RepositoryCitationView[]> {
  if (!snapshotId || !Array.isArray(excerptRefs) || excerptRefs.length === 0) {
    return [];
  }
  const refs = excerptRefs.filter(
    (row): row is StoredExcerptRef =>
      typeof row === "object" &&
      row !== null &&
      typeof (row as StoredExcerptRef).id === "string" &&
      typeof (row as StoredExcerptRef).relativeFilePath === "string",
  );
  if (refs.length === 0) {
    return [];
  }

  const snapshot = await prisma.repositoryContextSnapshot.findFirst({
    where: { id: snapshotId, workspaceId },
    include: {
      files: {
        where: { relativePath: { in: refs.map((row) => row.relativeFilePath) } },
      },
    },
  });
  if (!snapshot) {
    return [];
  }

  const views: RepositoryCitationView[] = [];
  for (const ref of refs) {
    const file = snapshot.files.find((row) => row.relativePath === ref.relativeFilePath);
    if (!file) {
      continue;
    }
    const lines = file.sanitizedText.split(/\r?\n/);
    const excerpt = lines.slice(ref.startLine - 1, ref.endLine).join("\n");
    views.push({
      id: ref.id,
      file: ref.relativeFilePath,
      commitSha: snapshot.commitSha,
      repository: snapshot.repository,
      startLine: ref.startLine,
      endLine: ref.endLine,
      excerpt,
      deploymentRelationship: "unknown",
      deploymentRelationshipNote: DEPLOYMENT_RELATIONSHIP_UNKNOWN,
    });
  }
  return views;
}

type StoredDocumentationExcerptRef = {
  id: string;
  documentId: string;
  sectionHeading: string;
  startLine: number;
  endLine: number;
};

async function loadDocumentationCitations(
  prisma: PrismaClient,
  workspaceId: string,
  excerptRefs: unknown,
  snapshotId: string | null,
): Promise<DocumentationCitationView[]> {
  if (!snapshotId || !Array.isArray(excerptRefs) || excerptRefs.length === 0) {
    return [];
  }
  const refs = excerptRefs.filter(
    (row): row is StoredDocumentationExcerptRef =>
      typeof row === "object" &&
      row !== null &&
      typeof (row as StoredDocumentationExcerptRef).id === "string" &&
      typeof (row as StoredDocumentationExcerptRef).documentId === "string",
  );
  if (refs.length === 0) {
    return [];
  }

  const snapshot = await prisma.documentationContextSnapshot.findFirst({
    where: { id: snapshotId, workspaceId },
    include: {
      documents: {
        where: { documentId: { in: refs.map((row) => row.documentId) } },
      },
    },
  });
  if (!snapshot) {
    return [];
  }

  const views: DocumentationCitationView[] = [];
  for (const ref of refs) {
    const document = snapshot.documents.find((row) => row.documentId === ref.documentId);
    if (!document) {
      continue;
    }
    const lines = document.sanitizedText.split(/\r?\n/);
    const excerpt = lines.slice(ref.startLine - 1, ref.endLine).join("\n");
    views.push({
      id: ref.id,
      title: document.title,
      documentId: document.documentId,
      section: ref.sectionHeading,
      contentVersion: document.contentVersion,
      contentSha256: document.contentSha256,
      startLine: ref.startLine,
      endLine: ref.endLine,
      excerpt,
      applicabilityNote: `${DOCUMENTATION_FRESHNESS_NOTE} ${DOCUMENTATION_AUTHORITY_NOTE}`,
      trustedSourceUrl: document.trustedSourceUrl,
    });
  }
  return views;
}

type StoredDeploymentEvidenceRef = {
  id: string;
  deploymentRecordId: string;
  sourceReportedAt: string;
  status: string;
};

async function loadDeploymentCitations(
  prisma: PrismaClient,
  workspaceId: string,
  evidenceRefs: unknown,
  included: boolean,
): Promise<DeploymentCitationView[]> {
  if (!included || !Array.isArray(evidenceRefs) || evidenceRefs.length === 0) {
    return [];
  }
  const refs = evidenceRefs.filter(
    (row): row is StoredDeploymentEvidenceRef =>
      typeof row === "object" &&
      row !== null &&
      typeof (row as StoredDeploymentEvidenceRef).id === "string" &&
      typeof (row as StoredDeploymentEvidenceRef).deploymentRecordId === "string",
  );
  if (refs.length === 0) {
    return [];
  }

  const records = await prisma.deploymentRecord.findMany({
    where: {
      workspaceId,
      id: { in: refs.map((row) => row.deploymentRecordId) },
    },
  });
  const events = await prisma.deploymentStatusEvent.findMany({
    where: {
      workspaceId,
      deploymentRecordId: { in: refs.map((row) => row.deploymentRecordId) },
    },
  });

  const views: DeploymentCitationView[] = [];
  for (const ref of refs) {
    const record = records.find((row) => row.id === ref.deploymentRecordId);
    if (!record) {
      continue;
    }
    const event =
      events.find(
        (row) =>
          row.deploymentRecordId === ref.deploymentRecordId &&
          row.sourceReportedAt.toISOString() === ref.sourceReportedAt &&
          row.status === ref.status,
      ) ?? events.find((row) => row.deploymentRecordId === ref.deploymentRecordId);
    if (!event) {
      continue;
    }
    const relationshipNote = record.replacesSourceDeploymentId
      ? `Recorded replacement of deployment ${opaqueDeploymentRef(record.replacesSourceDeploymentId)}.`
      : "Rollback or replacement relationship not supplied by the integration.";
    views.push({
      id: ref.id,
      status: ref.status,
      service: record.apiKey,
      environment: record.environment,
      sourceReportedAt: ref.sourceReportedAt,
      receivedAt: event.receivedAt.toISOString(),
      commitSha: record.commitSha,
      artifactRef: record.artifactRef,
      sourceDeploymentRef: opaqueDeploymentRef(record.sourceDeploymentId),
      relationshipNote,
      uncertaintyNote: DEPLOYMENT_TEMPORAL_NOTE,
    });
  }
  return views;
}
