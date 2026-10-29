import {
  investigationExplanationOutputSchema,
  type InvestigationExplanationOutputV1,
} from "@/lib/investigation/inference/explanation-output-v1";
import { INVESTIGATION_INFERENCE_LIMITS } from "@/lib/investigation/inference/config";
import type { InvestigationModelInput } from "@/lib/investigation/inference/rebuild-inference-input";
import { explanationCitationRejection, explanationClaimRejection, explanationTextEntries } from "@/lib/investigation/inference/explanation-claim-policy";
import { jsonUtf8ByteLength, utf8ByteLength } from "@/lib/investigation/inference/utf8-byte-length";
import { explanationRejection, schemaIssueLocation, type ExplanationFieldLocation, type ExplanationRejection } from "@/lib/investigation/inference/explanation-rejection-diagnostics";
import { renderStructuredSourceExplanation } from "./structured-source-explanation";
import { RUNTIME_EVIDENCE_GAPS } from "./runtime-evidence-gaps";

const FORBIDDEN_OUTPUT_PATTERNS = [
  /\bcorrected\s+payload\b/i,
  /\brun\s+this\s+command\b/i,
  /\bgit\s+apply\b/i,
  /\bcurl\s+-/i,
  /\bconfidence\s*:\s*\d/i,
  /\bconfidenceScore\b/i,
  /\bthis\s+code\s+caused\b/i,
  /\bcaused\s+the\s+production\s+failure\b/i,
  /\bdeployed\s+to\s+production\b/i,
  /\bthis\s+deployment\s+caused\b/i,
  /\bdeployment\s+caused\s+the\b/i,
  /\bbecause\s+of\s+the\s+deployment\b/i,
];

export type ValidateExplanationResult =
  | { ok: true; output: InvestigationExplanationOutputV1 }
  | { ok: false; code: string };

export type ValidateExplanationDiagnosticResult =
  | { ok: true; output: InvestigationExplanationOutputV1 }
  | ({ ok: false } & ExplanationRejection);

function collectCitationEntries(output: InvestigationExplanationOutputV1): Array<ExplanationFieldLocation & { id: string }> {
  return [
    ...output.evidenceCitations.map((row, itemIndex) => ({ id: row.id, field: "evidenceCitations.id" as const, itemIndex })),
    ...(["observedFindings", "hypotheses"] as const).flatMap((field) =>
      (output[field] ?? []).flatMap((row, itemIndex) => row.citationIds.map((id, citationIndex) => ({ id, field: `${field}.citationIds` as const, itemIndex, citationIndex }))),
    ),
  ];
}

function fieldMentionedInText(text: string, pointer: string): boolean {
  if (!pointer || pointer === "/") {
    return false;
  }
  const leaf = pointer.split("/").filter(Boolean).at(-1);
  if (!leaf) {
    return false;
  }
  return text.includes(leaf) || text.includes(pointer);
}

function allowedCitationIds(input: InvestigationModelInput): Set<string> {
  const allowed = new Set(input.evidenceItems.map((item) => item.id));
  if ((input.version === 2 || input.version === 3 || input.version === 4) && input.repositoryContext) {
    for (const excerpt of input.repositoryContext.excerpts) {
      allowed.add(excerpt.id);
    }
  }
  if ((input.version === 3 || input.version === 4) && input.documentationContext) {
    for (const excerpt of input.documentationContext.excerpts) {
      allowed.add(excerpt.id);
    }
  }
  if (input.version === 4 && input.deploymentContext) {
    for (const record of input.deploymentContext.records) {
      allowed.add(record.id);
    }
  }
  return allowed;
}

export function validateExplanationOutput(
  raw: unknown,
  input: InvestigationModelInput,
): ValidateExplanationResult {
  const result = validateExplanationOutputWithDiagnostics(raw, input);
  return result.ok ? result : { ok: false, code: result.code };
}

export function validateExplanationOutputWithDiagnostics(
  raw: unknown,
  input: InvestigationModelInput,
  options: { requireStructuredSources?: boolean } = {},
): ValidateExplanationDiagnosticResult {
  const reject = (rejection: ExplanationRejection): ValidateExplanationDiagnosticResult => ({ ok: false, ...rejection });
  if (typeof raw === "string") {
    if (utf8ByteLength(raw) > INVESTIGATION_INFERENCE_LIMITS.maxOutputUtf8Bytes) {
      return reject(explanationRejection("OUTPUT_SIZE_EXCEEDED", "output_size"));
    }
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      return reject(explanationRejection("OUTPUT_NOT_JSON", "json_syntax"));
    }
  }

  const serialized = JSON.stringify(raw);
  if (jsonUtf8ByteLength(raw) > INVESTIGATION_INFERENCE_LIMITS.maxOutputUtf8Bytes) {
    return reject(explanationRejection("OUTPUT_SIZE_EXCEEDED", "output_size"));
  }

  let generatedIncidentFindingCount = 0;
  if (options.requireStructuredSources || (typeof raw === "object" && raw !== null && "version" in raw && raw.version === 2)) {
    const rendered = renderStructuredSourceExplanation(raw, input);
    if (!rendered.ok) return reject(rendered);
    raw = rendered.output;
    generatedIncidentFindingCount = rendered.generatedIncidentFindingCount;
    if (jsonUtf8ByteLength(raw) > INVESTIGATION_INFERENCE_LIMITS.maxOutputUtf8Bytes) return reject(explanationRejection("OUTPUT_SIZE_EXCEEDED", "output_size"));
  }

  const parsed = investigationExplanationOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return reject(explanationRejection("OUTPUT_SCHEMA_INVALID", "output_schema", schemaIssueLocation(parsed.error.issues[0]?.path ?? [])));
  }
  const output = parsed.data;

  const allowedIds = allowedCitationIds(input);
  for (const { id, ...location } of collectCitationEntries(output)) {
    if (!allowedIds.has(id)) {
      return reject(explanationRejection("UNKNOWN_CITATION_ID", "unknown_citation", location));
    }
  }

  const blob = serialized;
  for (const [patternIndex, pattern] of FORBIDDEN_OUTPUT_PATTERNS.entries()) {
    if (pattern.test(blob)) {
      const entry = explanationTextEntries(output).find(({ text }) => pattern.test(text));
      const location: ExplanationFieldLocation = entry
        ? { field: entry.field, ...(entry.itemIndex !== undefined ? { itemIndex: entry.itemIndex } : {}) }
        : { field: "$" };
      return reject(explanationRejection("FORBIDDEN_OUTPUT_CONTENT", "forbidden_output_pattern", location, { patternIndex }));
    }
  }

  const claimFailure = explanationClaimRejection(output);
  if (claimFailure) return reject(claimFailure);
  const citationFailure = explanationCitationRejection(output, input, { generatedIncidentFindingCount });
  if (citationFailure) return reject(citationFailure);

  const registry = input.fieldRegistry;
  const textBlob = [
    output.summary,
    ...output.observedFindings.map((row) => row.description),
    ...(output.hypotheses ?? []).map((row) => row.description),
    ...output.limitations,
    ...output.missingContext,
    ...output.suggestedSteps,
  ].join("\n");

  for (const field of registry) {
    if (!fieldMentionedInText(textBlob, field.jsonPointer)) {
      continue;
    }
    const knownRule = registry.some(
      (row) =>
        row.jsonPointer === field.jsonPointer && row.ruleKeyword === field.ruleKeyword,
    );
    if (!knownRule) {
      return reject(explanationRejection("UNKNOWN_FIELD_REFERENCE", "unknown_field_reference"));
    }
  }

  const enrichedOutput = { ...output, missingContext: [...new Set([...RUNTIME_EVIDENCE_GAPS, ...output.missingContext])] };
  if (enrichedOutput.missingContext.length > INVESTIGATION_INFERENCE_LIMITS.maxListItems) return reject(explanationRejection("OUTPUT_SCHEMA_INVALID", "output_schema", { field: "missingContext" }));
  if (jsonUtf8ByteLength(enrichedOutput) > INVESTIGATION_INFERENCE_LIMITS.maxOutputUtf8Bytes) return reject(explanationRejection("OUTPUT_SIZE_EXCEEDED", "output_size"));
  return { ok: true, output: enrichedOutput };
}
