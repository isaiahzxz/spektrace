import type {
  IncidentSource,
  IncidentStatus,
  ValidationStatus,
} from "@/generated/prisma/enums";
import {
  findingsOf,
  parseValidationEvidence,
  type FindingView,
  type ParsedEvidence,
} from "@/lib/dashboard/evidence-adapter";
import {
  CATEGORY_LABEL,
  VALIDATION_LABEL,
  WORKFLOW_LABEL,
  driftLabel,
  statusCategory,
  type DriftLabel,
  type StatusCategory,
} from "@/lib/dashboard/incident-status";
import { formatUtc, shortIncidentId } from "@/lib/dashboard/queue-query";

export type IncidentRowView = {
  id: string;
  shortId: string;
  httpMethod: string;
  requestPath: string;
  statusCode: number;
  category: StatusCategory;
  categoryLabel: string;
  drift: DriftLabel;
  receivedAt: string;
};

export type ExplanationView = {
  state: "stored" | "pending" | "unsupported" | "failed" | "missing";
  heading: string;
  text: string | null;
  reasonCode: string | null;
};

export type RequestBodyView =
  | { kind: "missing" }
  | { kind: "json"; text: string; isJsonNull: boolean }
  | { kind: "unreadable" };

export type EvidencePanelView = {
  format: ParsedEvidence["format"];
  findings: FindingView[];
  unreadableFindings: number;
  scopeNote: string;
  checkedAt: string | null;
  validatorLabel: string | null;
  redactedPaths: string[];
  technicalJson: string | null;
};

export type SpecPanelView =
  | { kind: "none"; reason: string }
  | {
      kind: "pinned";
      id: string;
      name: string;
      version: string;
      openApiVersion: string;
      sourceFilename: string;
      sourceSha256: string;
      isCurrentlyActive: boolean;
      evidenceChecksum: "matches" | "differs" | "not-recorded";
    };

export type IncidentDetailView = {
  id: string;
  httpMethod: string;
  requestPath: string;
  statusCode: number;
  apiKey: string;
  environment: string;
  source: IncidentSource;
  sourceEventId: string;
  clientReference: string | null;
  category: StatusCategory;
  categoryLabel: string;
  workflowLabel: string;
  validationLabel: string;
  receivedAt: string;
  occurredAt: string;
  checkedAt: string | null;
  explanation: ExplanationView;
  body: RequestBodyView;
  evidence: EvidencePanelView;
  spec: SpecPanelView;
  processingError: { code: string | null; message: string | null } | null;
};

export type StoredRow = {
  id: string;
  httpMethod: string;
  requestPath: string;
  statusCode: number;
  status: IncidentStatus;
  validationStatus: ValidationStatus;
  validationEvidence: unknown;
  receivedAt: Date;
};

export type StoredDetail = StoredRow & {
  apiKey: string;
  environment: string;
  apiSpecId: string | null;
  source: IncidentSource;
  sourceEventId: string;
  clientReference: string | null;
  sanitizedRequestBody: unknown;
  occurredAt: Date;
  validatedAt: Date | null;
  processingErrorCode: string | null;
  processingErrorMessage: string | null;
  apiSpec: {
    id: string;
    name: string;
    version: string;
    openApiVersion: string;
    sourceFilename: string;
    sourceSha256: string;
    isActive: boolean;
  } | null;
};

/** Result of `jsonb_typeof(sanitized_request_body)`; SQL NULL means no body was submitted. */
export type StoredBodyType = string | null;

export function toIncidentRowView(row: StoredRow): IncidentRowView {
  const category = statusCategory(row.status, row.validationStatus);
  const evidence = parseValidationEvidence(row.validationEvidence);
  return {
    id: row.id,
    shortId: shortIncidentId(row.id),
    httpMethod: row.httpMethod,
    requestPath: row.requestPath,
    statusCode: row.statusCode,
    category,
    categoryLabel: CATEGORY_LABEL[category],
    drift: driftLabel(category, row.validationStatus, findingsOf(evidence)),
    receivedAt: formatUtc(row.receivedAt) ?? "",
  };
}

function storedExplanationText(evidence: ParsedEvidence): string | null {
  if (evidence.format !== "v1") return null;
  return evidence.plainEnglishSummary ?? evidence.reasonMessage;
}

export function buildExplanation(
  category: StatusCategory,
  evidence: ParsedEvidence,
): ExplanationView {
  const text = storedExplanationText(evidence);
  const reasonCode = evidence.format === "v1" ? evidence.reasonCode : null;

  switch (category) {
    case "pending":
      return {
        state: "pending",
        heading: "This request is waiting to be checked.",
        text: null,
        reasonCode: null,
      };
    case "unsupported":
      return {
        state: "unsupported",
        heading: "This check is outside the currently supported rules.",
        text,
        reasonCode,
      };
    case "failed":
      return {
        state: "failed",
        heading: "The check could not finish.",
        text,
        reasonCode,
      };
    case "triaged":
      return text
        ? { state: "stored", heading: "Explanation", text, reasonCode }
        : {
            state: "missing",
            heading: "No explanation was stored for this incident.",
            text: null,
            reasonCode,
          };
  }
}

function buildBody(
  bodyType: StoredBodyType,
  value: unknown,
): RequestBodyView {
  if (bodyType === null) return { kind: "missing" };
  if (bodyType === "null") return { kind: "json", text: "null", isJsonNull: true };
  try {
    return { kind: "json", text: JSON.stringify(value, null, 2), isJsonNull: false };
  } catch {
    return { kind: "unreadable" };
  }
}

function scopeNote(evidence: ParsedEvidence): string {
  if (evidence.format === "v1" && evidence.scope?.covers === "json_request_body_only") {
    const operation =
      evidence.scope.matchedMethod && evidence.scope.matchedPath
        ? ` for ${evidence.scope.matchedMethod} ${evidence.scope.matchedPath}`
        : "";
    return `This check covers the JSON request body only${operation}. Query parameters, headers, authentication, and business rules are not checked, so a matching body does not prove the whole request was valid.`;
  }
  return "The check scope was not recorded for this incident. This milestone only checks the supported JSON request body.";
}

function buildEvidencePanel(evidence: ParsedEvidence, rawEvidence: unknown): EvidencePanelView {
  const isReadable = evidence.format === "v1" || evidence.format === "legacy-findings";
  return {
    format: evidence.format,
    findings: findingsOf(evidence),
    unreadableFindings: isReadable ? evidence.unreadableFindings : 0,
    scopeNote: scopeNote(evidence),
    checkedAt: evidence.format === "v1" ? formatUtc(evidence.checkedAt) : null,
    validatorLabel:
      evidence.format === "v1" && evidence.validator?.engine
        ? [evidence.validator.engine, evidence.validator.schemaDialect]
            .filter(Boolean)
            .join(" · ")
        : null,
    redactedPaths: evidence.format === "v1" ? evidence.redactedPaths : [],
    technicalJson:
      rawEvidence === null || rawEvidence === undefined
        ? null
        : JSON.stringify(rawEvidence, null, 2),
  };
}

function buildSpecPanel(detail: StoredDetail, evidence: ParsedEvidence): SpecPanelView {
  if (!detail.apiSpecId || !detail.apiSpec) {
    const noActiveSpec =
      evidence.format === "v1" && evidence.reasonCode === "ACTIVE_SPEC_NOT_FOUND";
    return {
      kind: "none",
      reason: noActiveSpec
        ? `No active API specification existed for API key "${detail.apiKey}" when this incident arrived, so none was selected.`
        : "No API specification revision was selected for this incident.",
    };
  }

  const recorded =
    evidence.format === "v1" ? evidence.specRevision?.sourceSha256 ?? null : null;
  return {
    kind: "pinned",
    id: detail.apiSpec.id,
    name: detail.apiSpec.name,
    version: detail.apiSpec.version,
    openApiVersion: detail.apiSpec.openApiVersion,
    sourceFilename: detail.apiSpec.sourceFilename,
    sourceSha256: detail.apiSpec.sourceSha256,
    isCurrentlyActive: detail.apiSpec.isActive,
    evidenceChecksum: !recorded
      ? "not-recorded"
      : recorded === detail.apiSpec.sourceSha256
        ? "matches"
        : "differs",
  };
}

export function toIncidentDetailView(
  detail: StoredDetail,
  bodyType: StoredBodyType,
): IncidentDetailView {
  const category = statusCategory(detail.status, detail.validationStatus);
  const evidence = parseValidationEvidence(detail.validationEvidence);
  const hasError = detail.processingErrorCode || detail.processingErrorMessage;

  return {
    id: detail.id,
    httpMethod: detail.httpMethod,
    requestPath: detail.requestPath,
    statusCode: detail.statusCode,
    apiKey: detail.apiKey,
    environment: detail.environment,
    source: detail.source,
    sourceEventId: detail.sourceEventId,
    clientReference: detail.clientReference,
    category,
    categoryLabel: CATEGORY_LABEL[category],
    workflowLabel: WORKFLOW_LABEL[detail.status],
    validationLabel: VALIDATION_LABEL[detail.validationStatus],
    receivedAt: formatUtc(detail.receivedAt) ?? "",
    occurredAt: formatUtc(detail.occurredAt) ?? "",
    checkedAt:
      formatUtc(detail.validatedAt) ??
      (evidence.format === "v1" ? formatUtc(evidence.checkedAt) : null),
    explanation: buildExplanation(category, evidence),
    body: buildBody(bodyType, detail.sanitizedRequestBody),
    evidence: buildEvidencePanel(evidence, detail.validationEvidence),
    spec: buildSpecPanel(detail, evidence),
    processingError: hasError
      ? { code: detail.processingErrorCode, message: detail.processingErrorMessage }
      : null,
  };
}
