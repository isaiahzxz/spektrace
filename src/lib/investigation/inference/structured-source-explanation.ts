import { z } from "zod";
import { investigationExplanationOutputSchema, type InvestigationExplanationOutputV1 } from "./explanation-output-v1";
import type { InvestigationModelInput } from "./rebuild-inference-input";
import { deploymentSupportsCommitComparison } from "./deployment-commit-comparison";
import { explanationRejection, schemaIssueLocation, type ExplanationRejection } from "./explanation-rejection-diagnostics";

const legacy = investigationExplanationOutputSchema.shape;
const sourceId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}-[a-z0-9]{6,12}$`));
const observation = (prefix: string) => z.object({ excerptId: sourceId(prefix), description: z.string().min(1).max(1_000) }).strict();
const deploymentWords = /\b(?:deployment|deployments|deploy|deployed|deploying|rollouts?)\b/i;
const manualReviewText = {
  review_server_error_logs: "Review server-side error logs for additional evidence.",
  compare_request_schema: "Compare the captured request-body finding with the pinned OpenAPI schema.",
  inspect_client_serialization: "Manually inspect client serialization against the cited repository excerpt.",
  review_documentation_applicability: "Review whether the cited documentation applies to the pinned specification.",
  confirm_running_version_and_validation_settings: "Manually confirm the running service version and validation configuration; the imported records do not prove runtime state.",
} as const;
export const structuredSourceExplanationSchema = z.object({
  version: z.literal(2),
  incidentFindings: z.array(z.object({ evidenceId: sourceId("ev") }).strict()).min(1).max(20),
  repositoryObservations: z.array(observation("rx")).max(20),
  documentationObservations: z.array(observation("dx")).max(20),
  deploymentFacts: z.array(z.object({
    recordId: sourceId("dp"),
    status: z.enum(["STARTED", "SUCCEEDED", "FAILED", "ROLLED_BACK", "CANCELLED"]).nullable(),
    commitRelationship: z.enum(["matches_selected_snapshot", "mismatched_selected_snapshot"]).nullable(),
  }).strict()).max(8),
  hypotheses: z.array(z.object({
    label: z.string().min(1).max(128).regex(/^(?:Possible|Potential|Unverified|Hypothesis)\b/i), description: z.string().min(1).max(2_000),
    incidentRefs: z.array(sourceId("ev")).max(12),
    repositoryRefs: z.array(sourceId("rx")).max(12),
    documentationRefs: z.array(sourceId("dx")).max(12),
  }).strict()).max(20).optional(),
  missingContext: legacy.missingContext,
  manualReviewChecks: z.array(z.enum(Object.keys(manualReviewText) as [keyof typeof manualReviewText, ...(keyof typeof manualReviewText)[]])).max(5),
}).strict();

export function requiresStructuredSourceExplanation(input: InvestigationModelInput): boolean {
  return input.version === 4 && input.deploymentContext !== undefined && input.deploymentContext !== null;
}

export function renderStructuredSourceExplanation(raw: unknown, input: InvestigationModelInput):
  { ok: true; output: InvestigationExplanationOutputV1; generatedIncidentFindingCount: number } | ({ ok: false } & ExplanationRejection) {
  const parsed = structuredSourceExplanationSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, ...explanationRejection("OUTPUT_SCHEMA_INVALID", "output_schema", schemaIssueLocation(parsed.error.issues[0]?.path ?? [])) };
  const draft = parsed.data;
  for (const [itemIndex, hypothesis] of (draft.hypotheses ?? []).entries()) {
    for (const field of ["label", "description"] as const) {
      if (deploymentWords.test(hypothesis[field])) return { ok: false, ...explanationRejection("SOURCE_FACT_OUTSIDE_TYPED_FIELD", "structured_source_scope", { field: `hypotheses.${field}`, itemIndex }) };
      for (const [pattern, refs, prefix] of [[/\b(?:repository|repo|source code|code snippet)\b/i, hypothesis.repositoryRefs, "rx-"], [/\b(?:documentation|documented|runbook)\b/i, hypothesis.documentationRefs, "dx-"]] as const) {
        if (pattern.test(hypothesis[field]) && !refs.length) return { ok: false, ...explanationRejection("CLAIM_SOURCE_CITATION_MISMATCH", "source_citation_type", { field: `hypotheses.${field}`, itemIndex }, { requiredCitationPrefix: prefix }) };
      }
    }
  }
  for (const field of ["missingContext"] as const) {
    for (const [itemIndex, text] of draft[field].entries()) {
      if (deploymentWords.test(text)) return { ok: false, ...explanationRejection("SOURCE_FACT_OUTSIDE_TYPED_FIELD", "structured_source_scope", { field, itemIndex }) };
    }
  }
  const findings: InvestigationExplanationOutputV1["observedFindings"] = [];
  for (const [itemIndex, selection] of draft.incidentFindings.entries()) {
    const evidence = input.evidenceItems.find((row) => row.id === selection.evidenceId);
    if (!evidence) return { ok: false, ...explanationRejection("UNKNOWN_CITATION_ID", "unknown_citation", { field: "incidentFindings", itemIndex }) };
    const details = evidence.findings.slice(0, 3).map((finding) => {
      const expected = finding.constraints.find((constraint) => constraint.kind === "expected_json_type");
      return `${finding.jsonPointer || "/"} (${finding.ruleKeyword}${expected?.kind === "expected_json_type" ? `; expected ${expected.expectedJsonType}` : ""}${finding.observedJsonType ? `; observed ${finding.observedJsonType}` : ""})`;
    }).join("; ");
    findings.push({ description: `Supported JSON request-body validation recorded ${evidence.validationStatus}.${details ? ` Stored findings: ${details}.` : ""}${evidence.findings.length > 3 ? " Only the first three stored findings are listed." : ""} The incident also recorded HTTP ${evidence.http.statusCode}; its upstream cause is unverified.`, citationIds: [evidence.id] });
  }
  const repository = input.version !== 1 ? input.repositoryContext : undefined;
  const documentation = input.version === 3 || input.version === 4 ? input.documentationContext : undefined;
  for (const [rows, excerpts, label, field] of [
    [draft.repositoryObservations, repository?.excerpts, "Repository", "repositoryObservations"],
    [draft.documentationObservations, documentation?.excerpts, "Documentation", "documentationObservations"],
  ] as const) {
    for (const [itemIndex, row] of rows.entries()) {
      if (deploymentWords.test(row.description)) return { ok: false, ...explanationRejection("SOURCE_FACT_OUTSIDE_TYPED_FIELD", "structured_source_scope", { field, itemIndex }) };
      if (!excerpts?.some((excerpt) => excerpt.id === row.excerptId)) return { ok: false, ...explanationRejection("UNKNOWN_CITATION_ID", "unknown_citation", { field, itemIndex }) };
      findings.push({ description: `${label} evidence: ${row.description}`, citationIds: [row.excerptId] });
    }
  }
  const seen = new Set<string>();
  for (const [itemIndex, fact] of draft.deploymentFacts.entries()) {
    const record = input.version === 4 ? input.deploymentContext?.records.find((row) => row.id === fact.recordId) : undefined;
    const location = { field: "deploymentFacts" as const, itemIndex };
    if (!record) return { ok: false, ...explanationRejection("UNKNOWN_CITATION_ID", "unknown_citation", location) };
    if (seen.has(fact.recordId) || (fact.status === null && fact.commitRelationship === null) || (fact.status !== null && fact.status !== record.status)) return { ok: false, ...explanationRejection("DEPLOYMENT_FACT_NOT_SUPPORTED", "deployment_fact", location) };
    seen.add(fact.recordId);
    if (fact.commitRelationship !== null && !deploymentSupportsCommitComparison(input, [fact.recordId], fact.commitRelationship)) return { ok: false, ...explanationRejection("UNSUPPORTED_DEPLOYMENT_COMPARISON", "deployment_commit_comparison", location) };
    if (fact.status !== null) findings.push({ description: `Deployment evidence: the deployment record reports ${fact.status}.`, citationIds: [fact.recordId] });
    if (fact.commitRelationship !== null) findings.push({ description: `Deployment evidence: the recorded commit ${fact.commitRelationship === "matches_selected_snapshot" ? "matches" : "does not match"} the selected repository snapshot.`, citationIds: [fact.recordId] });
  }
  const hypotheses = draft.hypotheses?.map((row) => ({ label: row.label, description: row.description, citationIds: [...new Set([...row.incidentRefs, ...row.repositoryRefs, ...row.documentationRefs])] }));
  const ids = [...new Set([...findings.flatMap((row) => row.citationIds), ...(hypotheses ?? []).flatMap((row) => row.citationIds)])];
  const output = {
    summary: `Across ${input.groupedIncidentCount} grouped incident(s), ${input.validationOutcome === "PASSED" ? "the supported JSON request-body check passed" : input.validationOutcome === "MISMATCH" ? "the supported JSON request-body check recorded a mismatch" : "available contract evidence does not establish the failure cause"}. The upstream HTTP failure remains unexplained.`, observedFindings: findings,
    evidenceCitations: ids.map((id) => ({ id, label: id.startsWith("ev-") ? "Incident evidence" : id.startsWith("rx-") ? "Repository excerpt" : id.startsWith("dx-") ? "Documentation excerpt" : "Deployment record" })),
    ...(hypotheses ? { hypotheses } : {}),
    limitations: [
      "Validation covers only supported JSON request-body checks, not the full request or response.",
      "The upstream cause of the HTTP failure is not established.",
      ...(repository ? ["Repository excerpts describe stored source, not proven runtime behavior."] : []),
      ...(documentation ? ["Documentation is advisory and does not override pinned OpenAPI or deterministic findings."] : []),
      ...(input.version === 4 && input.deploymentContext ? ["Deployment timing and matching commits do not establish incident causation.", "A recorded commit match does not establish the running version or runtime configuration."] : []),
    ],
    missingContext: draft.missingContext, suggestedSteps: [...new Set(draft.manualReviewChecks)].map((code) => {
      if (code === "inspect_client_serialization" && !repository?.excerpts.length) return "Obtain relevant repository evidence before manually reviewing client serialization.";
      if (code === "review_documentation_applicability" && !documentation?.excerpts.length) return "Obtain relevant documentation and verify its applicability to the pinned specification.";
      return manualReviewText[code];
    }),
  };
  const bounded = investigationExplanationOutputSchema.safeParse(output);
  if (!bounded.success) return { ok: false, ...explanationRejection("OUTPUT_SCHEMA_INVALID", "output_schema", schemaIssueLocation(bounded.error.issues[0]?.path ?? [])) };
  return { ok: true, output: bounded.data, generatedIncidentFindingCount: draft.incidentFindings.length };
}
