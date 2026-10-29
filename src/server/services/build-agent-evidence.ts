import { ValidationStatus, type PrismaClient } from "@/generated/prisma/client";
import {
  AGENT_EVIDENCE_VERSION,
  agentEvidenceBundleSchema,
  type AgentEvidenceBundleV1,
  type AgentOmissionV1,
} from "@/lib/agent-evidence/agent-evidence-v1";
import { AGENT_EVIDENCE_LIMITS } from "@/lib/agent-evidence/limits";
import { scanSerializedBundleForLeaks } from "@/lib/agent-evidence/outbound-scan";
import { parseStoredValidationEvidence } from "@/lib/agent-evidence/parse-stored-evidence";
import { sanitizeValidationFindings } from "@/lib/agent-evidence/sanitize-findings";
import { resolveSafeOpenApiOperationPath } from "@/lib/agent-evidence/safe-path";
import { normalizeHttpMethod } from "@/lib/validation/incident-envelope";

export class AgentEvidenceNotFoundError extends Error {
  constructor() {
    super("Incident not found");
    this.name = "AgentEvidenceNotFoundError";
  }
}

export class AgentEvidenceReferenceMismatchError extends Error {
  readonly code = "SPEC_REVISION_MISMATCH" as const;

  constructor() {
    super("Incident specification reference does not match stored validation evidence");
    this.name = "AgentEvidenceReferenceMismatchError";
  }
}

export class AgentEvidenceBuildError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentEvidenceBuildError";
    this.code = code;
  }
}

function deterministicValidationStatus(
  incidentStatus: ValidationStatus,
  parsed: ReturnType<typeof parseStoredValidationEvidence>,
): ValidationStatus {
  if (parsed.format === "v1" && parsed.outcome) {
    return parsed.outcome;
  }
  if (parsed.format === "legacy" && parsed.findings.length > 0) {
    return ValidationStatus.MISMATCH;
  }
  return incidentStatus;
}

function pushOmission(
  omissions: AgentOmissionV1[],
  code: string,
  reason: string,
): void {
  if (omissions.length >= AGENT_EVIDENCE_LIMITS.maxOmissions) {
    return;
  }
  omissions.push({
    code: code.slice(0, AGENT_EVIDENCE_LIMITS.maxReasonCodeLength),
    reason: reason.slice(0, AGENT_EVIDENCE_LIMITS.maxOmissionReasonLength),
  });
}

function enforceBundleByteLimit(
  bundle: AgentEvidenceBundleV1,
  omissions: AgentOmissionV1[],
): AgentEvidenceBundleV1 {
  let serialized = JSON.stringify(bundle);
  if (serialized.length <= AGENT_EVIDENCE_LIMITS.maxBundleUtf8Bytes) {
    return bundle;
  }

  const trimmed: AgentEvidenceBundleV1 = {
    ...bundle,
    findings: [],
    protection: {
      ...bundle.protection,
      outputTruncated: true,
      evidenceComplete: false,
      omissions: [
        ...bundle.protection.omissions,
        ...omissions,
      ].slice(0, AGENT_EVIDENCE_LIMITS.maxOmissions),
    },
  };
  pushOmission(trimmed.protection.omissions, "BUNDLE_SIZE_EXCEEDED", "Bundle exceeded the UTF-8 size limit.");
  trimmed.protection.outputTruncated = true;
  trimmed.protection.evidenceComplete = false;

  serialized = JSON.stringify(trimmed);
  if (serialized.length > AGENT_EVIDENCE_LIMITS.maxBundleUtf8Bytes) {
    throw new AgentEvidenceBuildError(
      "BUNDLE_SIZE_EXCEEDED",
      "Agent evidence bundle could not be reduced to the size limit",
    );
  }
  return trimmed;
}

export async function buildAgentEvidenceBundle(
  prisma: PrismaClient,
  workspaceId: string,
  incidentId: string,
): Promise<AgentEvidenceBundleV1> {
  const incident = await prisma.incident.findFirst({
    where: { id: incidentId, workspaceId },
    include: { apiSpec: true },
  });

  if (!incident) {
    throw new AgentEvidenceNotFoundError();
  }

  const parsed = parseStoredValidationEvidence(incident.validationEvidence);
  if (parsed.format === "unrecognized") {
    throw new AgentEvidenceBuildError(
      "EVIDENCE_FORMAT_UNSUPPORTED",
      "Stored validation evidence format is not supported for agent export",
    );
  }

  const evidenceSpecId =
    parsed.format === "v1" ? parsed.specApiSpecId : null;
  if (
    incident.apiSpecId &&
    evidenceSpecId &&
    incident.apiSpecId !== evidenceSpecId
  ) {
    throw new AgentEvidenceReferenceMismatchError();
  }

  const omissions: AgentOmissionV1[] = [];
  const rawFindings =
    parsed.format === "v1" || parsed.format === "legacy" ? parsed.findings : [];
  const { findings, omissions: findingOmissions, truncated: findingsTruncated } =
    sanitizeValidationFindings(rawFindings);
  omissions.push(...findingOmissions);

  const redactedPaths =
    parsed.format === "v1" || parsed.format === "legacy" ? parsed.redactedPaths : [];
  const redactedPathCount = Math.min(
    redactedPaths.length,
    AGENT_EVIDENCE_LIMITS.maxRedactedPathEntries,
  );

  const reasonCode =
    parsed.format === "v1" ? parsed.reasonCode : null;
  const redactionBlockedValidation =
    reasonCode === "REDACTION_BLOCKED_VALIDATION" || redactedPathCount > 0;

  const pathResolution = resolveSafeOpenApiOperationPath({
    parsedDocument: incident.apiSpec?.parsedDocument ?? null,
    httpMethod: incident.httpMethod,
    concreteRequestPath: incident.requestPath,
    scopeMatchedPath: parsed.format === "v1" ? parsed.scopeMatchedPath : null,
  });

  if (pathResolution.omissionReasonCode) {
    pushOmission(
      omissions,
      pathResolution.omissionReasonCode,
      "HTTP operation path was omitted from the agent evidence bundle.",
    );
  }

  const specRevision = {
    apiSpecId: incident.apiSpecId,
    sourceSha256:
      parsed.format === "v1" && parsed.specSourceSha256
        ? parsed.specSourceSha256
        : incident.apiSpec?.sourceSha256 ?? null,
  };

  const validationStatus = deterministicValidationStatus(
    incident.validationStatus,
    parsed,
  );

  const evidenceComplete =
    parsed.format === "v1" &&
    !findingsTruncated &&
    !redactionBlockedValidation &&
    parsed.reasonCode !== "REDACTION_BLOCKED_VALIDATION";

  const bundle: AgentEvidenceBundleV1 = {
    version: AGENT_EVIDENCE_VERSION,
    incident: { id: incident.id },
    service: {
      apiKey: incident.apiKey,
      environment: incident.environment,
    },
    http: {
      method: normalizeHttpMethod(incident.httpMethod),
      statusCode: incident.statusCode,
      operationPath: pathResolution.operationPath,
      operationPathOmissionCode: pathResolution.omissionReasonCode,
    },
    specRevision,
    validation: {
      status: validationStatus,
      reasonCode,
      scopeCovers: parsed.format === "v1" ? parsed.scopeCovers : null,
      checkedAt: parsed.format === "v1" ? parsed.checkedAt : null,
    },
    findings,
    protection: {
      redactedPathCount,
      evidenceComplete,
      redactionBlockedValidation,
      omissions,
      outputTruncated: findingsTruncated,
    },
  };

  const bounded = enforceBundleByteLimit(bundle, omissions);
  const schemaCheck = agentEvidenceBundleSchema.safeParse(bounded);
  if (!schemaCheck.success) {
    throw new AgentEvidenceBuildError(
      "BUNDLE_SCHEMA_INVALID",
      "Agent evidence bundle failed schema validation",
    );
  }

  const serialized = JSON.stringify(schemaCheck.data);
  const leakScan = scanSerializedBundleForLeaks(serialized);
  if (!leakScan.safe) {
    throw new AgentEvidenceBuildError(
      leakScan.code,
      "Agent evidence bundle failed outbound safety checks",
    );
  }

  return schemaCheck.data;
}
