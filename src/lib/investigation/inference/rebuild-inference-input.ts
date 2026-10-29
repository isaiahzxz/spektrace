import { createHash } from "node:crypto";
import { ValidationStatus, type PrismaClient } from "@/generated/prisma/client";
import type { AgentFindingV1 } from "@/lib/agent-evidence/agent-evidence-v1";
import { INVESTIGATION_INFERENCE_LIMITS } from "@/lib/investigation/inference/config";
import { jsonUtf8ByteLength } from "@/lib/investigation/inference/utf8-byte-length";
import {
  protectedGroupEvidenceSummarySchema,
  type ProtectedGroupEvidenceSummaryV1,
} from "@/lib/investigation/protected-summary-v1";
import { buildAgentEvidenceBundle } from "@/server/services/build-agent-evidence";

export type InvestigationEvidenceItemV1 = {
  id: string;
  incidentId: string;
  validationStatus: ValidationStatus;
  http: {
    method: string;
    statusCode: number;
    operationPath: string | null;
    operationPathOmissionCode: string | null;
  };
  serviceRef: string;
  specRevision: {
    apiSpecId: string | null;
    sourceSha256: string | null;
  };
  findings: Array<{
    jsonPointer: string;
    ruleKeyword: string;
    schemaRulePath: string;
    observedJsonType: string | null;
    constraints: AgentFindingV1["constraints"];
  }>;
  protection: {
    evidenceComplete: boolean;
    redactionBlockedValidation: boolean;
    outputTruncated: boolean;
    omissionCodes: string[];
  };
};

export type InvestigationRepositoryContextBlockV1 = {
  snapshotId: string;
  repository: string;
  commitSha: string;
  deploymentRelationship: "unknown";
  excerpts: Array<{
    id: string;
    relativeFilePath: string;
    startLine: number;
    endLine: number;
    sanitizedExcerpt: string;
    retrievalMethod: string;
    limitations: string[];
  }>;
  missingContext: string[];
  limitations: string[];
};

export type InvestigationModelInputV1 = {
  version: 1;
  membershipVersion: number;
  groupedIncidentCount: number;
  includedEvidenceCount: number;
  unavailableEvidenceCount: number;
  omittedIncidentCount: number;
  operation: {
    method: string;
    operationPath: string | null;
    operationUnresolved: boolean;
  };
  validationOutcome: ValidationStatus;
  evidenceItems: InvestigationEvidenceItemV1[];
  fieldRegistry: Array<{
    jsonPointer: string;
    ruleKeyword: string;
    schemaRulePath: string;
  }>;
};

export type InvestigationDocumentationContextBlockV1 = {
  snapshotId: string;
  sourceKey: string;
  importedAt: string;
  excerpts: Array<{
    id: string;
    documentId: string;
    title: string;
    contentSha256: string;
    contentVersion: string | null;
    sectionHeading: string;
    startLine: number;
    endLine: number;
    sanitizedExcerpt: string;
    applicability: {
      kind: "unknown" | "api_spec";
      apiSpecId: string | null;
      status: "unknown" | "declared" | "mismatched_pinned_spec";
    };
    retrievalMethod: string;
    limitations: string[];
    trustedSourceUrl: string | null;
  }>;
  missingContext: string[];
  limitations: string[];
};

export type InvestigationModelInputV2 = Omit<InvestigationModelInputV1, "version"> & {
  version: 2;
  repositoryContext?: InvestigationRepositoryContextBlockV1;
};

export type InvestigationModelInputV3 = Omit<InvestigationModelInputV1, "version"> & {
  version: 3;
  repositoryContext?: InvestigationRepositoryContextBlockV1;
  documentationContext?: InvestigationDocumentationContextBlockV1;
};

export type InvestigationDeploymentContextBlockV1 = {
  referenceOccurredAt: string;
  lookbackMs: number;
  records: Array<{
    id: string;
    sourceDeploymentRef: string;
    status: string;
    sourceReportedAt: string;
    receivedAt: string;
    repository: string | null;
    commitSha: string | null;
    artifactRef: string | null;
    apiSpecId: string | null;
    runningVersionAssessment: string;
    repositoryCommitMatch: string;
    retrievalMethod: string;
    limitations: string[];
  }>;
  missingContext: string[];
  limitations: string[];
};

export type InvestigationModelInputV4 = Omit<InvestigationModelInputV1, "version"> & {
  version: 4;
  repositoryContext?: InvestigationRepositoryContextBlockV1;
  documentationContext?: InvestigationDocumentationContextBlockV1;
  deploymentContext?: InvestigationDeploymentContextBlockV1;
};

export type InvestigationModelInput =
  | InvestigationModelInputV1
  | InvestigationModelInputV2
  | InvestigationModelInputV3
  | InvestigationModelInputV4;

export type RebuildInferenceInputResult =
  | {
      ok: true;
      input: InvestigationModelInputV1;
      inputHash: string;
      includedEvidenceCount: number;
      unavailableEvidenceCount: number;
      omittedEvidenceCount: number;
    }
  | { ok: false; code: string };

function opaqueServiceRef(workspaceId: string, apiKey: string, environment: string): string {
  const digest = createHash("sha256")
    .update(`${workspaceId}\0${apiKey}\0${environment}`, "utf8")
    .digest("hex");
  return `svc-${digest.slice(0, 12)}`;
}

function evidenceItemId(index: number, incidentId: string): string {
  const digest = createHash("sha256").update(incidentId, "utf8").digest("hex").slice(0, 8);
  return `ev-${digest}`;
}

function mapFinding(finding: AgentFindingV1) {
  return {
    jsonPointer: finding.jsonPointer,
    ruleKeyword: finding.ruleKeyword,
    schemaRulePath: finding.schemaRulePath,
    observedJsonType: finding.observedJsonType,
    constraints: finding.constraints,
  };
}

function dominantValidationStatus(items: InvestigationEvidenceItemV1[]): ValidationStatus {
  if (items.length === 0) {
    return ValidationStatus.NOT_RUN;
  }
  const priority = [
    ValidationStatus.MISMATCH,
    ValidationStatus.ERROR,
    ValidationStatus.UNSUPPORTED,
    ValidationStatus.PASSED,
    ValidationStatus.NOT_RUN,
  ];
  for (const status of priority) {
    if (items.some((item) => item.validationStatus === status)) {
      return status;
    }
  }
  return items[0]!.validationStatus;
}

export async function rebuildInferenceInputFromPreparationRun(
  prisma: PrismaClient,
  workspaceId: string,
  preparationRunId: string,
): Promise<RebuildInferenceInputResult> {
  const run = await prisma.evidencePreparationRun.findFirst({
    where: { id: preparationRunId, workspaceId },
    include: { investigationGroup: true },
  });
  if (!run || !run.protectedSummary) {
    return { ok: false, code: "PREPARATION_RUN_NOT_READY" };
  }

  const parsedSummary = protectedGroupEvidenceSummarySchema.safeParse(run.protectedSummary);
  if (!parsedSummary.success) {
    return { ok: false, code: "PREPARATION_SUMMARY_INVALID" };
  }
  const summary: ProtectedGroupEvidenceSummaryV1 = parsedSummary.data;

  if (summary.membershipVersion !== run.membershipVersion) {
    return { ok: false, code: "MEMBERSHIP_SNAPSHOT_MISMATCH" };
  }

  const evidenceItems: InvestigationEvidenceItemV1[] = [];
  let unavailableEvidenceCount = 0;

  for (const [index, ref] of summary.includedIncidents.entries()) {
    if (ref.bundleVersion !== summary.evidenceFormatVersion) {
      unavailableEvidenceCount += 1;
      continue;
    }
    try {
      const bundle = await buildAgentEvidenceBundle(prisma, workspaceId, ref.incidentId);
      evidenceItems.push({
        id: evidenceItemId(index, ref.incidentId),
        incidentId: ref.incidentId,
        validationStatus: bundle.validation.status,
        http: {
          method: bundle.http.method,
          statusCode: bundle.http.statusCode,
          operationPath: bundle.http.operationPath,
          operationPathOmissionCode: bundle.http.operationPathOmissionCode,
        },
        serviceRef: opaqueServiceRef(
          workspaceId,
          bundle.service.apiKey,
          bundle.service.environment,
        ),
        specRevision: bundle.specRevision,
        findings: bundle.findings.map(mapFinding),
        protection: {
          evidenceComplete: bundle.protection.evidenceComplete,
          redactionBlockedValidation: bundle.protection.redactionBlockedValidation,
          outputTruncated: bundle.protection.outputTruncated,
          omissionCodes: bundle.protection.omissions.map((row) => row.code),
        },
      });
    } catch {
      unavailableEvidenceCount += 1;
    }
  }

  const groupedIncidentCount =
    summary.includedIncidentCount + summary.omittedIncidentCount;
  const operationPath =
    evidenceItems.find((item) => item.http.operationPath)?.http.operationPath ?? null;
  const operationUnresolved = run.investigationGroup.operationIdentity.startsWith(
    "__operation_unresolved__",
  );

  const fieldRegistry: InvestigationModelInputV1["fieldRegistry"] = [];
  const seen = new Set<string>();
  for (const item of evidenceItems) {
    for (const finding of item.findings) {
      const key = `${finding.jsonPointer}|${finding.ruleKeyword}|${finding.schemaRulePath}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      fieldRegistry.push({
        jsonPointer: finding.jsonPointer,
        ruleKeyword: finding.ruleKeyword,
        schemaRulePath: finding.schemaRulePath,
      });
    }
  }

  const input: InvestigationModelInputV1 = {
    version: 1,
    membershipVersion: summary.membershipVersion,
    groupedIncidentCount,
    includedEvidenceCount: evidenceItems.length,
    unavailableEvidenceCount,
    omittedIncidentCount: summary.omittedIncidentCount,
    operation: {
      method: run.investigationGroup.httpMethod,
      operationPath,
      operationUnresolved,
    },
    validationOutcome: dominantValidationStatus(evidenceItems),
    evidenceItems,
    fieldRegistry,
  };

  const serialized = JSON.stringify(input);
  if (jsonUtf8ByteLength(input) > INVESTIGATION_INFERENCE_LIMITS.maxEvidenceInputUtf8Bytes) {
    return { ok: false, code: "EVIDENCE_INPUT_SIZE_EXCEEDED" };
  }

  const inputHash = createHash("sha256").update(serialized, "utf8").digest("hex");

  return {
    ok: true,
    input,
    inputHash,
    includedEvidenceCount: evidenceItems.length,
    unavailableEvidenceCount,
    omittedEvidenceCount: summary.omittedIncidentCount,
  };
}

export function attachRepositoryContextToInferenceInput(
  base: InvestigationModelInputV1,
  repositoryContext: InvestigationRepositoryContextBlockV1,
): InvestigationModelInputV2 {
  return {
    ...base,
    version: 2,
    repositoryContext,
  };
}

export function fieldTokensFromInput(
  input: Pick<InvestigationModelInputV1, "fieldRegistry">,
): string[] {
  const tokens = new Set<string>();
  for (const field of input.fieldRegistry) {
    const leaf = field.jsonPointer.split("/").filter(Boolean).at(-1);
    if (leaf) {
      tokens.add(leaf);
    }
  }
  return [...tokens];
}

export function validateInferenceInputBeforeProvider(
  input: InvestigationModelInput,
): { ok: true } | { ok: false; code: string } {
  if (input.includedEvidenceCount === 0) {
    return { ok: false, code: "NO_USABLE_EVIDENCE" };
  }
  if (jsonUtf8ByteLength(input) > INVESTIGATION_INFERENCE_LIMITS.maxEvidenceInputUtf8Bytes) {
    return { ok: false, code: "EVIDENCE_INPUT_SIZE_EXCEEDED" };
  }
  return { ok: true };
}
