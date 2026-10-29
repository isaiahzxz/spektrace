import { z } from "zod";
import { INVESTIGATION_INFERENCE_LIMITS } from "@/lib/investigation/inference/config";

export const rejectionFields = [
  "$", "summary", "observedFindings", "observedFindings.description", "observedFindings.citationIds",
  "evidenceCitations", "evidenceCitations.id", "evidenceCitations.label",
  "hypotheses", "hypotheses.label", "hypotheses.description", "hypotheses.citationIds",
  "limitations", "missingContext", "suggestedSteps",
  "incidentFindings", "repositoryObservations", "documentationObservations", "deploymentFacts",
] as const;

const sourceCheckSchema = z.object({
  providedCitationPrefixes: z.array(z.enum(["ev-", "rx-", "dx-", "dp-"])).max(4),
  requiredCitationPrefixes: z.array(z.enum(["rx-", "dx-", "dp-"])).max(3),
  recognition: z.enum(["none", "atomic_only", "mixed"]),
  recognizedStatements: z.number().int().min(0).max(2_000),
  unrecognizedStatements: z.number().int().min(0).max(2_000),
  comparisonEvidence: z.object({
    selectedSnapshot: z.enum(["present", "missing", "invalid"]),
    citedDeployments: z.enum(["none", "present", "unknown"]),
    hashRelationship: z.enum(["equal", "different", "mixed", "missing", "invalid", "not_checked"]),
    recordedRelationship: z.enum(["match", "mismatch", "unknown", "mixed", "absent"]),
    verification: z.enum(["supported", "unsupported", "not_checked"]),
  }).strict(),
}).strict();
export type SourceCheckDiagnostic = z.infer<typeof sourceCheckSchema>;

export const explanationRejectionDiagnosticSchema = z.object({
  version: z.literal(1),
  field: z.enum(rejectionFields),
  itemIndex: z.number().int().min(0).max(INVESTIGATION_INFERENCE_LIMITS.maxListItems - 1).optional(),
  citationIndex: z.number().int().min(0).max(INVESTIGATION_INFERENCE_LIMITS.maxCitationIdsPerItem - 1).optional(),
  clauseIndex: z.number().int().min(0).max(2_000).optional(),
  patternIndex: z.number().int().min(0).max(31).optional(),
  rule: z.enum([
    "output_size", "json_syntax", "output_schema", "unknown_citation", "forbidden_output_pattern",
    "http_contract_exclusion", "response_validation_forward", "response_validation_reverse",
    "http_causation", "unsafe_remediation", "missing_claim_citation", "citation_catalog_incomplete",
    "source_citation_type", "summary_context_support", "unknown_field_reference", "deployment_commit_comparison",
    "deployment_fact",
    "structured_source_scope",
    "runtime_behavior_claim",
  ]),
  requiredCitationPrefix: z.enum(["rx-", "dx-", "dp-"]).optional(),
  sourceCheck: sourceCheckSchema.optional(),
}).strict();

export type ExplanationRejectionDiagnostic = z.infer<typeof explanationRejectionDiagnosticSchema>;
export type ExplanationFieldLocation = Pick<ExplanationRejectionDiagnostic, "field" | "itemIndex" | "citationIndex">;
export type ExplanationRejection = { code: string; diagnostic: ExplanationRejectionDiagnostic };

export function explanationRejection(
  code: string,
  rule: ExplanationRejectionDiagnostic["rule"],
  location: ExplanationFieldLocation = { field: "$" },
  details: Pick<ExplanationRejectionDiagnostic, "clauseIndex" | "patternIndex" | "requiredCitationPrefix" | "sourceCheck"> = {},
): ExplanationRejection {
  // Parsing a closed schema prevents accidental provider text from entering stored diagnostics.
  return { code, diagnostic: explanationRejectionDiagnosticSchema.parse({ version: 1, ...location, rule, ...details }) };
}

export function readExplanationRejectionDiagnostic(metadata: unknown): ExplanationRejectionDiagnostic | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const parsed = explanationRejectionDiagnosticSchema.safeParse(
    (metadata as Record<string, unknown>).explanationRejection,
  );
  return parsed.success ? parsed.data : null;
}

export function readInferenceTokenUsage(metadata: unknown): { promptTokens?: number; completionTokens?: number; totalTokens?: number } | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const result: { promptTokens?: number; completionTokens?: number; totalTokens?: number } = {};
  for (const key of ["promptTokens", "completionTokens", "totalTokens"] as const) {
    const value = (metadata as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) result[key] = value;
  }
  return Object.keys(result).length ? result : null;
}

export function schemaIssueLocation(path: readonly PropertyKey[]): ExplanationFieldLocation {
  const root = path[0];
  if (typeof root !== "string" || !rejectionFields.some((field) => field === root)) return { field: "$" };
  const index = path[1];
  const itemIndex = typeof index === "number" && Number.isInteger(index) && index >= 0 && index < INVESTIGATION_INFERENCE_LIMITS.maxListItems
    ? index : undefined;
  const child = typeof path[2] === "string" ? `${root}.${path[2]}` : root;
  const field = rejectionFields.find((candidate) => candidate === child) ?? rejectionFields.find((candidate) => candidate === root)!;
  return { field, ...(itemIndex !== undefined ? { itemIndex } : {}) };
}
