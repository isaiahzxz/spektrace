import type { AgentFindingV1, AgentOmissionV1, AgentSchemaConstraintV1 } from "@/lib/agent-evidence/agent-evidence-v1";
import { AGENT_EVIDENCE_LIMITS } from "@/lib/agent-evidence/limits";
import {
  sanitizeJsonPointer,
  sanitizePropertyName,
  sanitizeSchemaRulePath,
} from "@/lib/agent-evidence/safe-path";
import type { ValidationEvidenceItem } from "@/lib/validation/validate-json-schema";

const ALLOWED_OBSERVED_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "null",
  "array",
  "object",
]);

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

function constraintsForFinding(
  finding: ValidationEvidenceItem,
  omissions: AgentOmissionV1[],
): AgentSchemaConstraintV1[] {
  const constraints: AgentSchemaConstraintV1[] = [];

  if (finding.keyword === "type" && finding.expected) {
    const expected = finding.expected.slice(0, AGENT_EVIDENCE_LIMITS.maxRuleKeywordLength);
    constraints.push({ kind: "expected_json_type", expectedJsonType: expected });
  }

  if (finding.keyword === "required") {
    const name =
      finding.missingProperty ??
      missingPropertyFromMessage(finding.message);
    const safeName = name ? sanitizePropertyName(name) : null;
    if (safeName) {
      constraints.push({ kind: "required_property", propertyName: safeName });
    } else if (name) {
      pushOmission(omissions, "REQUIRED_PROPERTY_OMITTED", "Required property name was not safe to export.");
    }
  }

  if (finding.keyword === "additionalProperties" && finding.additionalProperty) {
    const safeName = sanitizePropertyName(finding.additionalProperty);
    if (safeName) {
      constraints.push({ kind: "unexpected_property", propertyName: safeName });
    } else {
      pushOmission(omissions, "UNEXPECTED_PROPERTY_OMITTED", "Unexpected property name was not safe to export.");
    }
  }

  if (finding.keyword === "enum" || finding.keyword === "const") {
    const count = finding.allowedValues?.length ?? 0;
    constraints.push({ kind: "enum_value_count", allowedValueCount: count });
  }

  return constraints.slice(0, AGENT_EVIDENCE_LIMITS.maxConstraintDepth);
}

function missingPropertyFromMessage(message: string): string | undefined {
  const match = /^must have required property '(.+)'$/.exec(message);
  return match?.[1];
}

function resolvePointerForFinding(
  finding: ValidationEvidenceItem,
  omissions: AgentOmissionV1[],
): string | null {
  const base = finding.jsonPointer === "" ? "/" : finding.jsonPointer;
  const sanitizedBase = sanitizeJsonPointer(base);
  if (sanitizedBase.omitted || !sanitizedBase.pointer) {
    pushOmission(
      omissions,
      sanitizedBase.reasonCode ?? "JSON_POINTER_OMITTED",
      "Finding location was not safe to export.",
    );
    return null;
  }

  if (finding.keyword === "required") {
    const name =
      finding.missingProperty ?? missingPropertyFromMessage(finding.message);
    const safeName = name ? sanitizePropertyName(name) : null;
    if (!safeName) {
      return sanitizedBase.pointer;
    }
    const child = sanitizeJsonPointer(`${sanitizedBase.pointer}/${safeName}`);
    if (child.omitted || !child.pointer) {
      pushOmission(omissions, "JSON_POINTER_OMITTED", "Required-field path was not safe to export.");
      return sanitizedBase.pointer;
    }
    return child.pointer;
  }

  if (finding.keyword === "additionalProperties" && finding.additionalProperty) {
    const safeName = sanitizePropertyName(finding.additionalProperty);
    if (!safeName) {
      return sanitizedBase.pointer;
    }
    const child = sanitizeJsonPointer(`${sanitizedBase.pointer}/${safeName}`);
    if (child.omitted || !child.pointer) {
      return sanitizedBase.pointer;
    }
    return child.pointer;
  }

  return sanitizedBase.pointer;
}

export function sanitizeValidationFindings(
  items: ValidationEvidenceItem[],
): { findings: AgentFindingV1[]; omissions: AgentOmissionV1[]; truncated: boolean } {
  const omissions: AgentOmissionV1[] = [];
  const findings: AgentFindingV1[] = [];
  let truncated = false;

  for (const item of items) {
    if (findings.length >= AGENT_EVIDENCE_LIMITS.maxFindings) {
      truncated = true;
      pushOmission(omissions, "FINDINGS_TRUNCATED", "Finding list exceeded the export limit.");
      break;
    }

    const keyword = item.keyword.slice(0, AGENT_EVIDENCE_LIMITS.maxRuleKeywordLength);
    const schemaPathResult = sanitizeSchemaRulePath(item.schemaPath);
    if (schemaPathResult.omitted || !schemaPathResult.path) {
      pushOmission(
        omissions,
        schemaPathResult.reasonCode ?? "SCHEMA_RULE_PATH_OMITTED",
        "Schema rule path was not safe to export.",
      );
      continue;
    }

    const jsonPointer = resolvePointerForFinding(item, omissions);
    if (!jsonPointer) {
      continue;
    }

    const observed =
      item.observedType && ALLOWED_OBSERVED_TYPES.has(item.observedType)
        ? item.observedType
        : null;

    findings.push({
      jsonPointer,
      ruleKeyword: keyword,
      schemaRulePath: schemaPathResult.path,
      observedJsonType: observed,
      constraints: constraintsForFinding(item, omissions),
    });
  }

  return { findings, omissions, truncated };
}
