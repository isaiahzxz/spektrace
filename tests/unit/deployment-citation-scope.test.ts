import { describe, expect, it } from "vitest";
import type { InvestigationModelInputV4 } from "@/lib/investigation/inference/rebuild-inference-input";
import type { InvestigationExplanationOutputV1 } from "@/lib/investigation/inference/explanation-output-v1";
import { validateExplanationOutputWithDiagnostics } from "@/lib/investigation/inference/validate-explanation-output";
import { sourceCheckDetails } from "@/lib/investigation/inference/source-check-details";
import { explanationRejectionDiagnosticSchema } from "@/lib/investigation/inference/explanation-rejection-diagnostics";

function input(): InvestigationModelInputV4 {
  return {
    version: 4, membershipVersion: 1, groupedIncidentCount: 1,
    includedEvidenceCount: 1, unavailableEvidenceCount: 0, omittedIncidentCount: 0,
    operation: { method: "POST", operationPath: "/payments", operationUnresolved: false },
    validationOutcome: "PASSED",
    evidenceItems: [{
      id: "ev-abc12345", incidentId: "synthetic-incident", validationStatus: "PASSED",
      http: { method: "POST", statusCode: 400, operationPath: "/payments", operationPathOmissionCode: null },
      serviceRef: "svc-synthetic", specRevision: { apiSpecId: null, sourceSha256: null }, findings: [],
      protection: { evidenceComplete: true, redactionBlockedValidation: false, outputTruncated: false, omissionCodes: [] },
    }], fieldRegistry: [],
    repositoryContext: {
      snapshotId: "synthetic-snapshot", repository: "synthetic/payments", commitSha: "a".repeat(40), deploymentRelationship: "unknown",
      excerpts: [{ id: "rx-abc12345", relativeFilePath: "src/amount.ts", startLine: 1, endLine: 1, sanitizedExcerpt: "return String(amount);", retrievalMethod: "mapping:field_identifier", limitations: [] }],
      missingContext: [], limitations: [],
    },
    deploymentContext: {
      referenceOccurredAt: "2026-02-01T14:00:00Z", lookbackMs: 604800000,
      records: [{
        id: "dp-abc12345", sourceDeploymentRef: "dep-synthetic", status: "SUCCEEDED",
        sourceReportedAt: "2026-02-01T13:30:00Z", receivedAt: "2026-02-01T13:31:00Z",
        repository: null, commitSha: "a".repeat(40), artifactRef: null, apiSpecId: null,
        runningVersionAssessment: "single_candidate", repositoryCommitMatch: "matches_selected_snapshot",
        retrievalMethod: "temporal_window:latest_status_at_reference", limitations: [],
      }], missingContext: [], limitations: [],
    },
  };
}

function explanation(description = "Deployment evidence: the recorded commit matches the selected repository snapshot."): InvestigationExplanationOutputV1 {
  return {
    summary: "The supplied deployment context includes a commit comparison.",
    observedFindings: [{ description, citationIds: ["dp-abc12345"] }],
    evidenceCitations: [{ id: "dp-abc12345", label: "Recorded deployment metadata" }],
    limitations: ["Timing alone does not establish incident causation."], missingContext: [], suggestedSteps: [],
  };
}

describe("deployment-record citation scope (synthetic offline evidence)", () => {
  it("rejects the reviewed live sentence when its repository-content claim has only a deployment citation", () => {
    const evidence = input();
    evidence.deploymentContext!.records[0]!.id = "dp-8d9f5c240a";
    const output = explanation("Deployment evidence records a successful deployment with the commit matching the repository snapshot containing the serialization function, but does not establish causation for the incident.");
    output.observedFindings[0]!.citationIds = ["dp-8d9f5c240a"];
    output.observedFindings.unshift(...Array.from({ length: 3 }, () => ({ description: "The supported body check passed.", citationIds: ["ev-abc12345"] })));
    output.evidenceCitations = [{ id: "dp-8d9f5c240a", label: "Recorded deployment metadata" }, { id: "ev-abc12345", label: "Body evidence" }];
    expect(validateExplanationOutputWithDiagnostics(output, evidence)).toMatchObject({ ok: false, code: "CLAIM_SOURCE_CITATION_MISMATCH", diagnostic: { field: "observedFindings.description", itemIndex: 3, requiredCitationPrefix: "rx-", sourceCheck: { recognition: "none", providedCitationPrefixes: ["dp-"], comparisonEvidence: { hashRelationship: "equal", recordedRelationship: "match" } } } });
  });

  it("accepts separate deployment status, commit comparison, and repository findings with their own citations", () => {
    const output = explanation();
    output.observedFindings = [
      { description: "Deployment evidence: the deployment record reports SUCCEEDED.", citationIds: ["dp-abc12345"] },
      { description: "Deployment evidence: the recorded commit matches the selected repository snapshot.", citationIds: ["dp-abc12345"] },
      { description: "Repository evidence: the repository excerpt serializes amount as a string.", citationIds: ["rx-abc12345"] },
    ];
    output.evidenceCitations.push({ id: "rx-abc12345", label: "Repository excerpt" });
    expect(validateExplanationOutputWithDiagnostics(output, input()).ok).toBe(true);
    output.observedFindings[2]!.citationIds = ["dp-abc12345"];
    expect(validateExplanationOutputWithDiagnostics(output, input())).toMatchObject({ ok: false, code: "CLAIM_SOURCE_CITATION_MISMATCH", diagnostic: { itemIndex: 2, requiredCitationPrefix: "rx-" } });
  });

  it("reports verified relationships without retaining hashes, text, or citation IDs", () => {
    const detail = sourceCheckDetails("The recorded deployment commit matches the selected repository snapshot.", ["dp-abc12345"], input(), []);
    expect(detail.comparisonEvidence).toEqual({ selectedSnapshot: "present", citedDeployments: "present", hashRelationship: "equal", recordedRelationship: "match", verification: "supported" });
    expect(JSON.stringify(detail)).not.toContain("abc12345");
    expect(JSON.stringify(detail)).not.toContain("a".repeat(40));
    expect(explanationRejectionDiagnosticSchema.safeParse({ version: 1, field: "summary", rule: "source_citation_type", sourceCheck: detail }).success).toBe(true);
    expect(explanationRejectionDiagnosticSchema.safeParse({ version: 1, field: "summary", rule: "source_citation_type", sourceCheck: { ...detail, sentence: "private" } }).success).toBe(false);
  });
  it("distinguishes inconsistent flags from actual SHA disagreement", () => {
    const evidence = input();
    evidence.deploymentContext!.records[0]!.repositoryCommitMatch = "mismatched_selected_snapshot";
    expect(sourceCheckDetails("The recorded deployment commit matches the selected repository snapshot.", ["dp-abc12345"], evidence, []).comparisonEvidence).toMatchObject({ hashRelationship: "equal", recordedRelationship: "mismatch", verification: "unsupported" });
  });
  it("reports unknown cited events instead of borrowing uncited metadata", () => {
    expect(sourceCheckDetails("The recorded deployment commit matches the selected repository snapshot.", ["dp-unknown"], input(), []).comparisonEvidence).toMatchObject({ citedDeployments: "unknown", hashRelationship: "not_checked", verification: "unsupported" });
  });
  it("accepts a recorded commit comparison supported by its own deployment citation", () => {
    expect(validateExplanationOutputWithDiagnostics(explanation(), input()).ok).toBe(true);
  });

  it("accepts a summary repeating that same supported metadata fact", () => {
    const output = explanation();
    output.summary = "The recorded deployment commit matches the selected repository snapshot.";
    expect(validateExplanationOutputWithDiagnostics(output, input()).ok).toBe(true);
  });

  it("rejects a false match even when both citation types are attached", () => {
    const evidence = input();
    evidence.deploymentContext!.records[0]!.commitSha = "b".repeat(40);
    evidence.deploymentContext!.records[0]!.repositoryCommitMatch = "mismatched_selected_snapshot";
    const output = explanation();
    output.observedFindings[0]!.citationIds.push("rx-abc12345");
    output.evidenceCitations.push({ id: "rx-abc12345", label: "Source excerpt" });
    expect(validateExplanationOutputWithDiagnostics(output, evidence).ok).toBe(false);
  });

  it("keeps repository code claims blocked when only deployment evidence is cited", () => {
    expect(validateExplanationOutputWithDiagnostics(explanation("Repository code serializes amount as a string."), input())).toMatchObject({ ok: false, code: "CLAIM_SOURCE_CITATION_MISMATCH" });
  });

  it("does not let a supported metadata sentence excuse a later code claim", () => {
    const output = explanation("Deployment evidence: the recorded commit matches the selected repository snapshot. Repository code serializes amount as a string.");
    expect(validateExplanationOutputWithDiagnostics(output, input())).toMatchObject({ ok: false, code: "CLAIM_SOURCE_CITATION_MISMATCH" });
  });

  it.each([
    "The recorded deployment commit matches the selected repository snapshot.",
    "Deployment evidence: the deployment record's commit SHA matches the selected repository snapshot's commit SHA.",
    "Deployment evidence: recorded commit matches the selected repository snapshot",
  ])("supports bounded atomic metadata phrasing: %s", (description) => {
    expect(validateExplanationOutputWithDiagnostics(explanation(description), input()).ok).toBe(true);
  });

  it.each([
    ["missing repository context", (evidence: InvestigationModelInputV4) => { delete evidence.repositoryContext; }],
    ["missing deployment context", (evidence: InvestigationModelInputV4) => { delete evidence.deploymentContext; }],
    ["missing deployment SHA", (evidence: InvestigationModelInputV4) => { evidence.deploymentContext!.records[0]!.commitSha = null; }],
    ["unknown comparison", (evidence: InvestigationModelInputV4) => { evidence.deploymentContext!.records[0]!.repositoryCommitMatch = "unknown"; }],
    ["contradictory comparison flag", (evidence: InvestigationModelInputV4) => { evidence.deploymentContext!.records[0]!.repositoryCommitMatch = "mismatched_selected_snapshot"; }],
    ["contradictory comparison SHA", (evidence: InvestigationModelInputV4) => { evidence.deploymentContext!.records[0]!.commitSha = "b".repeat(40); }],
    ["malformed SHA", (evidence: InvestigationModelInputV4) => { evidence.repositoryContext!.commitSha = "not-a-commit"; }],
  ])("rejects a comparison with %s", (_name, mutate) => {
    const evidence = input();
    mutate(evidence);
    expect(validateExplanationOutputWithDiagnostics(explanation(), evidence).ok).toBe(false);
  });

  it("does not borrow a matching event that the finding never cited", () => {
    const evidence = input();
    evidence.deploymentContext!.records.push({ ...evidence.deploymentContext!.records[0]!, id: "dp-def67890" });
    evidence.deploymentContext!.records[0]!.commitSha = "b".repeat(40);
    evidence.deploymentContext!.records[0]!.repositoryCommitMatch = "mismatched_selected_snapshot";
    expect(validateExplanationOutputWithDiagnostics(explanation(), evidence).ok).toBe(false);
  });

  it("rejects contradictory cited events rather than choosing the convenient one", () => {
    const evidence = input();
    evidence.deploymentContext!.records.push({ ...evidence.deploymentContext!.records[0]!, id: "dp-def67890", commitSha: "b".repeat(40), repositoryCommitMatch: "mismatched_selected_snapshot" });
    const output = explanation();
    output.observedFindings[0]!.citationIds.push("dp-def67890");
    output.evidenceCitations.push({ id: "dp-def67890", label: "Other event" });
    expect(validateExplanationOutputWithDiagnostics(output, evidence).ok).toBe(false);
  });

  it("accepts a mismatch only when both the recorded flag and SHAs establish it", () => {
    const evidence = input();
    evidence.deploymentContext!.records[0]!.commitSha = "b".repeat(40);
    evidence.deploymentContext!.records[0]!.repositoryCommitMatch = "mismatched_selected_snapshot";
    expect(validateExplanationOutputWithDiagnostics(explanation("The recorded deployment commit does not match the selected repository snapshot."), evidence).ok).toBe(true);
  });

  it("does not use a hypothesis as observed summary support", () => {
    const output = explanation();
    output.summary = "The recorded deployment commit matches the selected repository snapshot.";
    output.hypotheses = [{ label: "Unverified relationship", description: output.observedFindings[0]!.description, citationIds: ["dp-abc12345"] }];
    output.observedFindings = [];
    expect(validateExplanationOutputWithDiagnostics(output, input())).toMatchObject({ ok: false, code: "SUMMARY_CONTEXT_NOT_GROUNDED" });
  });

  it("does not extend commit comparison support to code behavior in the summary", () => {
    const output = explanation();
    output.summary = "The recorded deployment commit matches the selected repository snapshot. Repository code serializes the amount as a string.";
    expect(validateExplanationOutputWithDiagnostics(output, input())).toMatchObject({ ok: false, code: "SUMMARY_CONTEXT_NOT_GROUNDED" });
  });

  it("does not extend the exception to a compound sentence about repository code", () => {
    const output = explanation("The recorded deployment commit matches the selected repository snapshot and repository code serializes amount as a string.");
    expect(validateExplanationOutputWithDiagnostics(output, input())).toMatchObject({ ok: false, code: "CLAIM_SOURCE_CITATION_MISMATCH" });
  });

  it("rejects causal HTTP claims even when metadata comparisons are supported", () => {
    const output = explanation();
    output.suggestedSteps = ["The mismatch caused HTTP 400."];
    expect(validateExplanationOutputWithDiagnostics(output, input())).toMatchObject({ ok: false, code: "UNSUPPORTED_HTTP_CAUSATION" });
  });

  it("recognizes equivalent uppercase and lowercase commit hashes", () => {
    const evidence = input();
    evidence.deploymentContext!.records[0]!.commitSha = "A".repeat(40);
    expect(validateExplanationOutputWithDiagnostics(explanation(), evidence).ok).toBe(true);
  });

  it("rejects a false mismatch flag for equivalent uppercase and lowercase hashes", () => {
    const evidence = input();
    evidence.deploymentContext!.records[0]!.commitSha = "A".repeat(40);
    evidence.deploymentContext!.records[0]!.repositoryCommitMatch = "mismatched_selected_snapshot";
    expect(validateExplanationOutputWithDiagnostics(explanation("The recorded deployment commit does not match the selected repository snapshot."), evidence).ok).toBe(false);
  });
});
