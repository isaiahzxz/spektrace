import type { InvestigationModelInput } from "@/lib/investigation/inference/rebuild-inference-input";
import type { SourceCheckDiagnostic } from "@/lib/investigation/inference/explanation-rejection-diagnostics";

export type CommitComparison = "matches_selected_snapshot" | "mismatched_selected_snapshot";
const FULL_COMMIT_SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;

// Only atomic metadata statements qualify; arbitrary prose keeps the source-citation guard.
export function deploymentCommitStatements(text: string): Array<{ text: string; comparison: CommitComparison | null }> {
  return text.split(/(?<=[.!?])\s+|;/).filter((part) => part.trim()).map((part) => {
    const normalized = part.trim().replace(/^Deployment evidence:\s*/i, "");
    const match = /^(?:the\s+)?(?:(?:recorded\s+)?deployment(?:\s+(?:event|record))?(?:['’]s)?\s+)?(?:recorded\s+)?commit(?:\s+sha)?\s+(matches|does not match)\s+(?:the\s+)?selected\s+repository\s+snapshot(?:['’]s\s+commit(?:\s+sha)?)?\.?$/i.exec(normalized);
    return {
      text: part,
      comparison: match ? (match[1]!.toLowerCase() === "matches" ? "matches_selected_snapshot" : "mismatched_selected_snapshot") : null,
    };
  });
}

export function deploymentSupportsCommitComparison(
  input: InvestigationModelInput,
  citationIds: readonly string[],
  comparison: CommitComparison,
): boolean {
  return inspectDeploymentCommitEvidence(input, citationIds, comparison).verification === "supported";
}

export function inspectDeploymentCommitEvidence(
  input: InvestigationModelInput | undefined,
  citationIds: readonly string[],
  comparison?: CommitComparison,
): SourceCheckDiagnostic["comparisonEvidence"] {
  const snapshotSha = input?.version === 4 ? input.repositoryContext?.commitSha : undefined;
  const ids = new Set(citationIds.filter((id) => id.startsWith("dp-")));
  const records = input?.version === 4 ? (input.deploymentContext?.records ?? []).filter((record) => ids.has(record.id)) : [];
  const selectedSnapshot = !snapshotSha ? "missing" : FULL_COMMIT_SHA.test(snapshotSha) ? "present" : "invalid";
  const citedDeployments = !ids.size ? "none" : records.length === ids.size ? "present" : "unknown";
  const hashes = records.map((record) => !record.commitSha || !snapshotSha ? "missing" : !FULL_COMMIT_SHA.test(record.commitSha) || !FULL_COMMIT_SHA.test(snapshotSha) ? "invalid" : record.commitSha.toLowerCase() === snapshotSha.toLowerCase() ? "equal" : "different");
  const flags = records.map((record) => record.repositoryCommitMatch === "matches_selected_snapshot" ? "match" : record.repositoryCommitMatch === "mismatched_selected_snapshot" ? "mismatch" : "unknown");
  const hashRelationship = !hashes.length ? "not_checked" : new Set(hashes).size === 1 ? hashes[0]! : "mixed";
  const recordedRelationship = !flags.length ? "absent" : new Set(flags).size === 1 ? flags[0]! : "mixed";
  const supported = selectedSnapshot === "present" && citedDeployments === "present" &&
    (comparison === "matches_selected_snapshot" ? hashRelationship === "equal" && recordedRelationship === "match" : hashRelationship === "different" && recordedRelationship === "mismatch");
  return { selectedSnapshot, citedDeployments, hashRelationship, recordedRelationship, verification: !comparison ? "not_checked" : supported ? "supported" : "unsupported" };
}
