import type { InvestigationExplanationOutputV1 } from "@/lib/investigation/inference/explanation-output-v1";
import { explanationRejection, type ExplanationFieldLocation, type ExplanationRejection } from "@/lib/investigation/inference/explanation-rejection-diagnostics";
import type { InvestigationModelInput } from "@/lib/investigation/inference/rebuild-inference-input";
import { deploymentCommitStatements, deploymentSupportsCommitComparison, type CommitComparison } from "@/lib/investigation/inference/deployment-commit-comparison";
import { sourceCheckDetails } from "@/lib/investigation/inference/source-check-details";

export function explanationTextEntries(output: InvestigationExplanationOutputV1): Array<ExplanationFieldLocation & { text: string }> {
  return [
    { field: "summary", text: output.summary },
    ...output.observedFindings.map((row, itemIndex) => ({ field: "observedFindings.description" as const, itemIndex, text: row.description })),
    ...output.evidenceCitations.map((row, itemIndex) => ({ field: "evidenceCitations.label" as const, itemIndex, text: row.label })),
    ...(output.hypotheses ?? []).flatMap((row, itemIndex) => [
      { field: "hypotheses.label" as const, itemIndex, text: row.label },
      { field: "hypotheses.description" as const, itemIndex, text: row.description },
    ]),
    ...(["limitations", "missingContext", "suggestedSteps"] as const).flatMap((field) => output[field].map((text, itemIndex) => ({ field, itemIndex, text }))),
  ];
}

export function explanationTexts(output: InvestigationExplanationOutputV1): string[] {
  return explanationTextEntries(output).map((entry) => entry.text);
}

function explicitlyUncertain(clause: string): boolean {
  return /\b(?:(?:does not|do not|cannot|can't)\s+(?:establish|explain|prove|determine|conclude)|(?:unknown|unverified|unproven|unclear)\s+(?:whether|why)|(?:was|were|is|are|has been|have been)\s+not\s+validated|(?:no|insufficient)\s+evidence\s+(?:that|to|establishes|supports)|not\s+established\s+(?:that|whether))\b/i.test(clause);
}

// Conservative language guards catch known failure modes, not arbitrary semantic errors.
export function explanationClaimFailure(output: InvestigationExplanationOutputV1): string | null {
  return explanationClaimRejection(output)?.code ?? null;
}

export function explanationClaimRejection(output: InvestigationExplanationOutputV1): ExplanationRejection | null {
  for (const { text, ...location } of explanationTextEntries(output)) {
    const clauses = text.split(/(?<=[.!?])\s+|;|,|\bbut\b|\bhowever\b/i);
    for (const [clauseIndex, clause] of clauses.entries()) {
      if (/\b(?:4\d{2}|4xx|http|response)\b.{0,70}\b(?:not due to|not caused by|ruled out)\b.{0,45}\bcontract\b/i.test(clause)) {
        return explanationRejection("UNSUPPORTED_VALIDATION_SCOPE", "http_contract_exclusion", location, { clauseIndex });
      }
      if (explicitlyUncertain(clause)) continue;
      if (/\b(?:accepted\s+by\s+(?:the\s+)?(?:service|server|backend)(?:\s+logic)?|(?:service|server|backend)(?:\s+(?:logic|code|behavior))?\s+(?:already\s+)?accepts?\b)/i.test(clause)) {
        return explanationRejection("UNSUPPORTED_RUNTIME_BEHAVIOR", "runtime_behavior_claim", location, { clauseIndex });
      }
      if (/\b(?:validat(?:ion|or|ors)|schema|specification|openapi)\b.{0,100}\b(?:adjust(?:ed|ing)?|updat(?:ed|ing)|chang(?:ed|ing)?|relax(?:ed|ing)?)\b.{0,75}\b(?:accept|allow|permit)\b/i.test(clause)) {
        return explanationRejection("UNSUPPORTED_REMEDIATION_ADVICE", "unsafe_remediation", location, { clauseIndex });
      }
      if (/\b(?:response|responses|entire contract|full contract|complete contract)\b.{0,65}\b(?:conform(?:ed|s)?|validat(?:ed|es|ing)|match(?:ed|es)?|pass(?:ed|es)?)\b/i.test(clause)) {
        return explanationRejection("UNSUPPORTED_VALIDATION_SCOPE", "response_validation_forward", location, { clauseIndex });
      }
      if (/\b(?:validat(?:ed|es|ing)|conform(?:ed|s)?|pass(?:ed|es)?)\b.{0,55}\b(?:response|responses|entire contract|full contract|complete contract)\b/i.test(clause)) {
        return explanationRejection("UNSUPPORTED_VALIDATION_SCOPE", "response_validation_reverse", location, { clauseIndex });
      }

      const http = /\b(?:4\d{2}|4xx|http\s+(?:response|status|error)|bad request|upstream\s+(?:response|error))\b/i;
      // "Response causes beyond body validation" names missing context, not a causal predicate.
      const causalText = clause.replace(/\b(?:http\s+)?(?:response|error|status)\s+causes\s+beyond\b/gi, "response context beyond");
      const causal = /\b(?:leads? to|leading to|results? in|resulting in|caus(?:es|ed|ing)|(?:is|was)\s+the\s+(?:root\s+)?cause\s+of|(?:will|would|may|might|could|can|did)\s+cause|trigger(?:s|ed|ing)?|due to|because of)\b/i;
      if (http.test(clause) && causal.test(causalText)) return explanationRejection("UNSUPPORTED_HTTP_CAUSATION", "http_causation", location, { clauseIndex });
      if (/\b(?:add(?:ing)?|introduc(?:e|ing)|allow(?:ing)?|recommend\w*)\b.{0,90}\b(?:validation exceptions?|bypass\w*|relax\w*|weaken\w*)\b/i.test(clause)) {
        return explanationRejection("UNSUPPORTED_REMEDIATION_ADVICE", "unsafe_remediation", location, { clauseIndex });
      }
    }
  }
  return null;
}

type ContextPrefix = "rx-" | "dx-" | "dp-";
function contextPrefixes(text: string): ContextPrefix[] {
  const prefixes: ContextPrefix[] = [];
  if (/\b(?:repository|repo|source code|code snippet|repository snapshot)\b/i.test(text)) prefixes.push("rx-");
  if (/\b(?:documentation|documented|runbook)\b/i.test(text)) prefixes.push("dx-");
  if (/\b(?:deployment|deployed|rollout)\b/i.test(text)) prefixes.push("dp-");
  return prefixes;
}

function requiredContextPrefixes(text: string): ContextPrefix[] {
  const withoutAbsenceStatements = text.replace(
    /\b(?:no|missing|unavailable)\s+(?:repository|repo|documentation|deployment)(?:\s+(?:context|evidence|records|excerpts))?\b|\b(?:repository|repo|documentation|deployment)\s+(?:context|evidence|relationship|records)\s+(?:is\s+|was\s+)?(?:unknown|unavailable|missing|not supplied|not available|not provided)\b/gi,
    "",
  );
  return contextPrefixes(withoutAbsenceStatements);
}

export function explanationCitationFailure(output: InvestigationExplanationOutputV1, input?: InvestigationModelInput): string | null {
  return explanationCitationRejection(output, input)?.code ?? null;
}

export function explanationCitationRejection(output: InvestigationExplanationOutputV1, input?: InvestigationModelInput, options: { generatedIncidentFindingCount?: number } = {}): ExplanationRejection | null {
  const catalog = new Set(output.evidenceCitations.map((row) => row.id));
  const establishedComparisons = new Set<CommitComparison>();
  const claims = [
    ...output.observedFindings.map((claim, itemIndex) => ({ claim, itemIndex, field: "observedFindings" as const })),
    ...(output.hypotheses ?? []).map((claim, itemIndex) => ({ claim, itemIndex, field: "hypotheses" as const })),
  ];
  for (const { claim, itemIndex, field } of claims) {
    const citationLocation = { field: `${field}.citationIds` as const, itemIndex };
    if (!claim.citationIds.length) return explanationRejection("UNCITED_EXPLANATION_CLAIM", "missing_claim_citation", citationLocation);
    const citationIndex = claim.citationIds.findIndex((id) => !catalog.has(id));
    if (citationIndex >= 0) return explanationRejection("CITATION_CATALOG_INCOMPLETE", "citation_catalog_incomplete", { ...citationLocation, citationIndex });
    const statements = input ? deploymentCommitStatements(claim.description) : [];
    const comparisons = statements.flatMap((statement) => statement.comparison ? [statement.comparison] : []);
    if (input && comparisons.some((comparison) => !deploymentSupportsCommitComparison(input, claim.citationIds, comparison))) {
      return explanationRejection("UNSUPPORTED_DEPLOYMENT_COMPARISON", "deployment_commit_comparison", { field: `${field}.description`, itemIndex }, { sourceCheck: sourceCheckDetails(claim.description, claim.citationIds, input, ["dp-"]) });
    }
    // Mixed prose stays conservative: a metadata sentence cannot excuse additional code claims.
    const metadataOnly = comparisons.length > 0 && comparisons.length === statements.length;
    const generatedIncidentFact = field === "observedFindings" && itemIndex < (options.generatedIncidentFindingCount ?? 0);
    for (const prefix of requiredContextPrefixes(metadataOnly || generatedIncidentFact ? "" : claim.description)) {
      if (!claim.citationIds.some((id) => id.startsWith(prefix))) return explanationRejection("CLAIM_SOURCE_CITATION_MISMATCH", "source_citation_type", { field: `${field}.description`, itemIndex }, { requiredCitationPrefix: prefix, sourceCheck: sourceCheckDetails(claim.description, claim.citationIds, input, requiredContextPrefixes(claim.description)) });
    }
    if (field === "observedFindings") for (const comparison of comparisons) establishedComparisons.add(comparison);
  }
  const summaryStatements = input ? deploymentCommitStatements(output.summary) : [];
  for (const statement of summaryStatements) {
    if (statement.comparison && !establishedComparisons.has(statement.comparison)) {
      return explanationRejection("SUMMARY_CONTEXT_NOT_GROUNDED", "summary_context_support", { field: "summary" }, { requiredCitationPrefix: "dp-" });
    }
  }
  const summaryContext = input ? summaryStatements.filter((statement) => !statement.comparison).map((statement) => statement.text).join(" ") : output.summary;
  for (const prefix of requiredContextPrefixes(summaryContext)) {
    if (!output.observedFindings.some((claim) =>
      contextPrefixes(claim.description).includes(prefix) && claim.citationIds.some((id) => id.startsWith(prefix)),
    )) return explanationRejection("SUMMARY_CONTEXT_NOT_GROUNDED", "summary_context_support", { field: "summary" }, { requiredCitationPrefix: prefix });
  }
  return null;
}
