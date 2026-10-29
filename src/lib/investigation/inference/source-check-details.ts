import { deploymentCommitStatements, inspectDeploymentCommitEvidence } from "@/lib/investigation/inference/deployment-commit-comparison";
import type { SourceCheckDiagnostic } from "@/lib/investigation/inference/explanation-rejection-diagnostics";
import type { InvestigationModelInput } from "@/lib/investigation/inference/rebuild-inference-input";

export function sourceCheckDetails(
  text: string, citationIds: readonly string[], input: InvestigationModelInput | undefined,
  requiredCitationPrefixes: SourceCheckDiagnostic["requiredCitationPrefixes"],
): SourceCheckDiagnostic {
  const statements = deploymentCommitStatements(text);
  const comparisons = statements.flatMap((part) => part.comparison ? [part.comparison] : []);
  const checkedComparison = comparisons.find((comparison) => inspectDeploymentCommitEvidence(input, citationIds, comparison).verification === "unsupported") ?? comparisons[0];
  return {
    providedCitationPrefixes: (["ev-", "rx-", "dx-", "dp-"] as const).filter((prefix) => citationIds.some((id) => id.startsWith(prefix))),
    requiredCitationPrefixes: [...new Set(requiredCitationPrefixes)],
    recognition: comparisons.length === 0 ? "none" : comparisons.length === statements.length ? "atomic_only" : "mixed",
    recognizedStatements: comparisons.length,
    unrecognizedStatements: statements.length - comparisons.length,
    comparisonEvidence: inspectDeploymentCommitEvidence(input, citationIds, checkedComparison),
  };
}
