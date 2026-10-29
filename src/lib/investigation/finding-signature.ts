import { createHash } from "node:crypto";
import { ValidationStatus } from "@/generated/prisma/client";
import {
  resolveSafeOpenApiOperationPath,
  sanitizeJsonPointer,
  sanitizePropertyName,
  sanitizeSchemaRulePath,
} from "@/lib/agent-evidence/safe-path";
import { parseStoredValidationEvidence } from "@/lib/agent-evidence/parse-stored-evidence";
import type { ValidationEvidenceItem } from "@/lib/validation/validate-json-schema";

const UNRESOLVED_OPERATION = "__operation_unresolved__";

export function unresolvedOperationIdentity(): string {
  return UNRESOLVED_OPERATION;
}

/** Isolates unresolved operations per incident without persisting concrete request paths. */
export function unresolvedOperationIdentityForIncident(incidentId: string): string {
  const digest = createHash("sha256").update(incidentId, "utf8").digest("hex").slice(0, 16);
  return `${UNRESOLVED_OPERATION}:i:${digest}`;
}

function fieldLabelForFinding(finding: ValidationEvidenceItem): string {
  const pointer = sanitizeJsonPointer(finding.jsonPointer);
  if (pointer.pointer && !pointer.omitted) {
    return pointer.pointer;
  }
  if (finding.missingProperty) {
    const name = sanitizePropertyName(finding.missingProperty);
    if (name) {
      return `/${name}`;
    }
  }
  if (finding.additionalProperty) {
    const name = sanitizePropertyName(finding.additionalProperty);
    if (name) {
      return `/${name}`;
    }
  }
  return "_field_omitted";
}

function expectedConstraintToken(finding: ValidationEvidenceItem): string {
  if (finding.expected) {
    return `expected:${finding.keyword}:${finding.expected}`;
  }
  if (finding.missingProperty) {
    return `required:${finding.missingProperty}`;
  }
  if (finding.additionalProperty) {
    return `additional:${finding.additionalProperty}`;
  }
  if (finding.allowedValues && finding.allowedValues.length > 0) {
    return `allowed_count:${finding.allowedValues.length}`;
  }
  return `keyword:${finding.keyword}`;
}

function mismatchFindingSignature(finding: ValidationEvidenceItem): string {
  const field = fieldLabelForFinding(finding);
  const rulePath =
    sanitizeSchemaRulePath(finding.schemaPath).path ?? "_rule_omitted";
  const rule = finding.keyword.slice(0, 64);
  const expected = expectedConstraintToken(finding);
  return `${field}|${rule}|${rulePath}|${expected}`;
}

export function computeFindingSignature(
  validationStatus: ValidationStatus,
  validationEvidence: unknown,
): string {
  const parsed = parseStoredValidationEvidence(validationEvidence);

  if (validationStatus === ValidationStatus.NOT_RUN) {
    return "outcome:not_run";
  }

  if (validationStatus === ValidationStatus.PASSED) {
    return "outcome:passed";
  }

  if (validationStatus === ValidationStatus.UNSUPPORTED) {
    const code =
      parsed.format === "v1" && parsed.reasonCode
        ? parsed.reasonCode
        : "UNSUPPORTED";
    return `outcome:unsupported:${code}`;
  }

  if (validationStatus === ValidationStatus.ERROR) {
    const code =
      parsed.format === "v1" && parsed.reasonCode
        ? parsed.reasonCode
        : "VALIDATION_ERROR";
    return `outcome:error:${code}`;
  }

  const findings =
    parsed.format === "v1" || parsed.format === "legacy" ? parsed.findings : [];
  if (findings.length === 0) {
    return "outcome:mismatch:no_findings";
  }

  const parts = findings
    .map((finding) => mismatchFindingSignature(finding))
    .sort()
    .join(";");
  return `outcome:mismatch:${parts}`;
}

export function resolveOperationIdentity(input: {
  parsedDocument: unknown;
  httpMethod: string;
  concreteRequestPath: string;
  scopeMatchedPath: string | null;
}): string {
  const resolved = resolveSafeOpenApiOperationPath({
    parsedDocument: input.parsedDocument,
    httpMethod: input.httpMethod,
    concreteRequestPath: input.concreteRequestPath,
    scopeMatchedPath: input.scopeMatchedPath,
  });
  if (resolved.operationPath) {
    return resolved.operationPath;
  }
  return UNRESOLVED_OPERATION;
}
