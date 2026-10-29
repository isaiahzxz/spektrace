import { describe, expect, it, vi, afterEach } from "vitest";
import type { InvestigationModelInputV4 } from "@/lib/investigation/inference/rebuild-inference-input";
import { validateExplanationOutputWithDiagnostics } from "@/lib/investigation/inference/validate-explanation-output";
import { structuredSourceExplanationSchema } from "@/lib/investigation/inference/structured-source-explanation";
import { createRecordingGatewayAdapter } from "@/lib/investigation/inference/adapters/recording-gateway-adapter";
import { createGatewayInferenceAdapter } from "@/lib/investigation/inference/adapters/gateway-adapter";
import { buildTrustedSystemPrompt, outputJsonSchemaDescription } from "@/lib/investigation/inference/explanation-prompt-v1";

export function contextInput(): InvestigationModelInputV4 {
  return { version: 4, membershipVersion: 1, groupedIncidentCount: 1, includedEvidenceCount: 1, unavailableEvidenceCount: 0, omittedIncidentCount: 0,
    operation: { method: "POST", operationPath: "/payments", operationUnresolved: false }, validationOutcome: "PASSED", fieldRegistry: [],
    evidenceItems: [{ id: "ev-abc12345", incidentId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", validationStatus: "PASSED", serviceRef: "svc-abc", http: { method: "POST", statusCode: 400, operationPath: "/payments", operationPathOmissionCode: null }, specRevision: { apiSpecId: null, sourceSha256: null }, findings: [], protection: { evidenceComplete: true, redactionBlockedValidation: false, outputTruncated: false, omissionCodes: [] } }],
    repositoryContext: { snapshotId: "synthetic", repository: "synthetic/payments", commitSha: "a".repeat(40), deploymentRelationship: "unknown", excerpts: [{ id: "rx-abc12345", relativeFilePath: "src/amount.ts", startLine: 1, endLine: 1, sanitizedExcerpt: "return String(amount);", retrievalMethod: "mapping:field_identifier", limitations: [] }], missingContext: [], limitations: [] },
    deploymentContext: { referenceOccurredAt: "2026-02-01T14:00:00Z", lookbackMs: 604800000, records: [{ id: "dp-abc12345", sourceDeploymentRef: "dep-synthetic", status: "SUCCEEDED", sourceReportedAt: "2026-02-01T13:30:00Z", receivedAt: "2026-02-01T13:31:00Z", repository: null, commitSha: "a".repeat(40), artifactRef: null, apiSpecId: null, runningVersionAssessment: "single_candidate", repositoryCommitMatch: "matches_selected_snapshot", retrievalMethod: "temporal_window:latest_status_at_reference", limitations: [] }], missingContext: [], limitations: [] },
  };
}
export function draft() {
  return { version: 2 as const, incidentFindings: [{ evidenceId: "ev-abc12345" }], repositoryObservations: [{ excerptId: "rx-abc12345", description: "The repository excerpt serializes amount as a string." }], documentationObservations: [], deploymentFacts: [{ recordId: "dp-abc12345", status: "SUCCEEDED", commitRelationship: "matches_selected_snapshot" }], missingContext: [], manualReviewChecks: [] };
}
describe("structured source explanation boundary", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  it.each(["/deployment", "/repository", "/documentation"])("keeps generated incident field %s distinct from external-source prose", (jsonPointer) => {
    const input = contextInput();
    input.evidenceItems[0]!.findings = [{ jsonPointer, ruleKeyword: "type", schemaRulePath: "#/properties/value/type", observedJsonType: "string", constraints: [{ kind: "expected_json_type", expectedJsonType: "integer" }] }];
    expect(validateExplanationOutputWithDiagnostics(draft(), input).ok).toBe(true);
    const fake = { ...draft(), repositoryObservations: [{ excerptId: "rx-abc12345", description: "Deployment records report a successful rollout." }] };
    expect(validateExplanationOutputWithDiagnostics(fake, input).ok).toBe(false);
  });
  it("requests missing source evidence rather than inventing cited excerpts in manual steps", () => {
    const input = contextInput(); delete input.repositoryContext;
    const result = validateExplanationOutputWithDiagnostics({ ...draft(), repositoryObservations: [], deploymentFacts: [], manualReviewChecks: ["inspect_client_serialization", "review_documentation_applicability"] }, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output.suggestedSteps.join(" ")).not.toContain("cited");
    expect(result.output.suggestedSteps[0]).toContain("Obtain relevant repository evidence");
  });
  it("renders independently grounded deployment and repository findings into the existing inspector shape", () => {
    const result = validateExplanationOutputWithDiagnostics(draft(), contextInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output.observedFindings).toContainEqual({ description: "Deployment evidence: the deployment record reports SUCCEEDED.", citationIds: ["dp-abc12345"] });
    expect(result.output.observedFindings).toContainEqual({ description: "Deployment evidence: the recorded commit matches the selected repository snapshot.", citationIds: ["dp-abc12345"] });
    expect(result.output.observedFindings).toContainEqual({ description: "Repository evidence: The repository excerpt serializes amount as a string.", citationIds: ["rx-abc12345"] });
    expect(result.output.limitations).toContain("Deployment timing and matching commits do not establish incident causation.");
    expect(result.output).not.toHaveProperty("deploymentFacts");
    expect(result.output.summary).toContain("the supported JSON request-body check passed");
  });
  it.each([
    "Deployment evidence records a successful deployment with the commit matching the repository snapshot containing the serialization function, but does not establish causation for the incident.",
    "Deployment evidence reports a SUCCEEDED deployment with commit SHA matching the repository snapshot containing the serialization code.",
  ])("cannot put reviewed mixed-source prose into typed deployment facts: %s", (description) => {
    const value = { ...draft(), deploymentFacts: [{ ...draft().deploymentFacts[0], description }] };
    expect(structuredSourceExplanationSchema.safeParse(value).success).toBe(false);
    expect(validateExplanationOutputWithDiagnostics(value, contextInput())).toMatchObject({ ok: false, code: "OUTPUT_SCHEMA_INVALID" });
  });
  it("rejects false deployment status and false commit relationships", () => {
    expect(validateExplanationOutputWithDiagnostics({ ...draft(), deploymentFacts: [{ ...draft().deploymentFacts[0], status: "FAILED" }] }, contextInput())).toMatchObject({ ok: false, code: "DEPLOYMENT_FACT_NOT_SUPPORTED" });
    const input = contextInput(); input.deploymentContext!.records[0]!.commitSha = "b".repeat(40);
    expect(validateExplanationOutputWithDiagnostics(draft(), input)).toMatchObject({ ok: false, code: "UNSUPPORTED_DEPLOYMENT_COMPARISON" });
  });
  it("rejects inconsistent comparison flags despite equal SHA values", () => {
    const input = contextInput(); input.deploymentContext!.records[0]!.repositoryCommitMatch = "mismatched_selected_snapshot";
    expect(validateExplanationOutputWithDiagnostics(draft(), input).ok).toBe(false);
  });
  it("requires repository references in repository observations and resolves actual supplied IDs", () => {
    for (const excerptId of ["dp-abc12345", "rx-deadbeef"]) {
      expect(validateExplanationOutputWithDiagnostics({ ...draft(), repositoryObservations: [{ excerptId, description: "The repository excerpt serializes amount as a string." }] }, contextInput()).ok).toBe(false);
    }
    const input = contextInput(); delete input.repositoryContext;
    expect(validateExplanationOutputWithDiagnostics(draft(), input).ok).toBe(false);
  });
  it("does not permit deployment prose to migrate into incident or repository observations", () => {
    const value = draft(); value.repositoryObservations[0]!.description = "Deployment evidence reports a SUCCEEDED deployment containing the serialization code.";
    expect(validateExplanationOutputWithDiagnostics(value, contextInput())).toMatchObject({ ok: false, code: "SOURCE_FACT_OUTSIDE_TYPED_FIELD" });
  });
  it("keeps upstream causation and unsafe-action guards after rendering", () => {
    const result = validateExplanationOutputWithDiagnostics(draft(), contextInput());
    if (!result.ok) throw new Error("Expected valid fixture");
    expect(validateExplanationOutputWithDiagnostics({ ...result.output, suggestedSteps: ["The mismatch caused HTTP 400."] }, contextInput())).toMatchObject({ ok: false, code: "UNSUPPORTED_HTTP_CAUSATION" });
  });
  it("never lets a model add HTTP causation to a deterministic incident finding", () => {
    expect(validateExplanationOutputWithDiagnostics({ ...draft(), incidentFindings: [{ evidenceId: "ev-abc12345", description: "causing a type mismatch and resulting in HTTP 400." }] }, contextInput())).toMatchObject({ ok: false, code: "OUTPUT_SCHEMA_INVALID" });
    const result = validateExplanationOutputWithDiagnostics(draft(), contextInput());
    if (!result.ok) throw new Error("Expected valid fixture");
    expect(result.output.observedFindings[0]!.description).toContain("recorded PASSED");
    expect(result.output.observedFindings[0]!.description).toContain("HTTP 400; its upstream cause is unverified");
  });
  it.each([
    "Verify if the OpenAPI specification should be updated to allow string types for 'amount' to support legacy clients.",
    "Check if the validation logic can be adjusted to accept decimal strings or if clients need to be updated to send integers.",
  ])("rejects live advice to weaken the contract: %s", (text) => {
    const result = validateExplanationOutputWithDiagnostics(draft(), contextInput());
    if (!result.ok) throw new Error("Expected valid fixture");
    expect(validateExplanationOutputWithDiagnostics({ ...result.output, suggestedSteps: [text] }, contextInput())).toMatchObject({ ok: false, code: "UNSUPPORTED_REMEDIATION_ADVICE" });
    expect(validateExplanationOutputWithDiagnostics({ ...draft(), suggestedSteps: [text] }, contextInput()).ok).toBe(false);
  });
  it("rejects a live inference of actual service acceptance from serialization source code", () => {
    const hypothesis = { label: "Possible client serialization difference", description: "This discrepancy likely causes the validation failure when a string is sent, despite it being accepted by the service logic.", incidentRefs: ["ev-abc12345"], repositoryRefs: ["rx-abc12345"], documentationRefs: [] };
    expect(validateExplanationOutputWithDiagnostics({ ...draft(), hypotheses: [hypothesis] }, contextInput())).toMatchObject({ ok: false, code: "UNSUPPORTED_RUNTIME_BEHAVIOR" });
  });
  it("rejects the observed HTTP causation clause even in a sourced hypothesis", () => {
    const hypothesis = { label: "Possible client serialization mismatch", description: "The client may serialize amount as a string, causing a validation mismatch and HTTP 400 response.", incidentRefs: ["ev-abc12345"], repositoryRefs: ["rx-abc12345"], documentationRefs: [] };
    expect(validateExplanationOutputWithDiagnostics({ ...draft(), hypotheses: [hypothesis] }, contextInput())).toMatchObject({ ok: false, code: "UNSUPPORTED_HTTP_CAUSATION" });
  });
  it("checks source references and diagnostic location in hypothesis labels too", () => {
    const hypothesis = { label: "Possible repository serialization difference", description: "This remains uncertain.", incidentRefs: ["ev-abc12345"], repositoryRefs: [], documentationRefs: [] };
    expect(validateExplanationOutputWithDiagnostics({ ...draft(), hypotheses: [hypothesis] }, contextInput())).toMatchObject({ ok: false, code: "CLAIM_SOURCE_CITATION_MISMATCH", diagnostic: { field: "hypotheses.label" } });
    expect(validateExplanationOutputWithDiagnostics({ ...draft(), hypotheses: [{ ...hypothesis, label: "Possible deployment effect" }] }, contextInput())).toMatchObject({ ok: false, diagnostic: { field: "hypotheses.label" } });
  });
  it("rejects the observed repository/documentation hypothesis with incident references alone", () => {
    const hypothesis = { label: "Possible client serialization difference", description: "Repository code serializes amounts as strings, and documentation acknowledges legacy clients may send decimal strings.", incidentRefs: ["ev-abc12345"], repositoryRefs: [], documentationRefs: [] };
    expect(validateExplanationOutputWithDiagnostics({ ...draft(), hypotheses: [hypothesis] }, contextInput())).toMatchObject({ ok: false, code: "CLAIM_SOURCE_CITATION_MISMATCH" });
    const repositoryOnly = { ...hypothesis, description: "Repository code serializes amounts as strings; this may indicate a client serialization difference.", repositoryRefs: ["rx-abc12345"] };
    expect(validateExplanationOutputWithDiagnostics({ ...draft(), hypotheses: [repositoryOnly] }, contextInput()).ok).toBe(true);
    expect(validateExplanationOutputWithDiagnostics({ ...draft(), hypotheses: [{ ...repositoryOnly, repositoryRefs: ["rx-deadbeef"] }] }, contextInput()).ok).toBe(false);
    expect(validateExplanationOutputWithDiagnostics({ ...draft(), hypotheses: [{ ...repositoryOnly, description: "Deployment evidence confirms the running version." }] }, contextInput()).ok).toBe(false);
  });
  it("does not let free-text summaries or hypotheses bypass typed deployment status checks", () => {
    expect(validateExplanationOutputWithDiagnostics({ ...draft(), summary: "The deployment failed." }, contextInput()).ok).toBe(false);
    expect(validateExplanationOutputWithDiagnostics({ ...draft(), hypotheses: [{ label: "Uncertain deployment context", description: "Deployment evidence: the deployment record reports FAILED.", citationIds: ["dp-abc12345"] }] }, contextInput()).ok).toBe(false);
  });
  it.each(["missingContext"] as const)("rejects deployment claims hidden in %s", (field) => {
    expect(validateExplanationOutputWithDiagnostics({ ...draft(), [field]: ["The deployment failed."] }, contextInput())).toMatchObject({ ok: false, code: "SOURCE_FACT_OUTSIDE_TYPED_FIELD", diagnostic: { field } });
  });
  it("renders the safe runtime-check request from a fixed manual-review choice", () => {
    const result = validateExplanationOutputWithDiagnostics({ ...draft(), manualReviewChecks: ["confirm_running_version_and_validation_settings"] }, contextInput());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output.suggestedSteps).toEqual(["Manually confirm the running service version and validation configuration; the imported records do not prove runtime state."]);
    expect(validateExplanationOutputWithDiagnostics({ ...draft(), manualReviewChecks: ["relax_validation"] }, contextInput()).ok).toBe(false);
  });
  it("rejects the observed running-version overclaim and generates evidence limitations itself", () => {
    expect(validateExplanationOutputWithDiagnostics({ ...draft(), limitations: ["Deployment evidence confirms the running version matches the repository snapshot but does not confirm runtime behavior or validation configuration."] }, contextInput())).toMatchObject({ ok: false, code: "OUTPUT_SCHEMA_INVALID" });
    const result = validateExplanationOutputWithDiagnostics(draft(), contextInput());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output.limitations).toContain("A recorded commit match does not establish the running version or runtime configuration.");
  });
  it("fails closed on legacy output when a gateway structured contract is required", () => {
    const legacy = { summary: "Unknown.", observedFindings: [], evidenceCitations: [], limitations: [], missingContext: [], suggestedSteps: [] };
    expect(validateExplanationOutputWithDiagnostics(legacy, contextInput(), { requireStructuredSources: true })).toMatchObject({ ok: false, code: "OUTPUT_SCHEMA_INVALID" });
    expect(validateExplanationOutputWithDiagnostics(legacy, contextInput()).ok).toBe(true);
  });
  it("keeps commit comparison unavailable without a selected snapshot and permits status-only facts", () => {
    const input = contextInput(); delete input.repositoryContext;
    const value = { ...draft(), repositoryObservations: [] };
    expect(validateExplanationOutputWithDiagnostics(value, input)).toMatchObject({ ok: false, code: "UNSUPPORTED_DEPLOYMENT_COMPARISON" });
    expect(validateExplanationOutputWithDiagnostics({ ...value, deploymentFacts: [{ recordId: "dp-abc12345", status: "SUCCEEDED", commitRelationship: null }] }, input).ok).toBe(true);
  });
  it("rejects invented deployments, duplicate facts, empty facts, and total rendered overflow", () => {
    const value = draft();
    for (const deploymentFacts of [[{ ...value.deploymentFacts[0], recordId: "dp-deadbeef" }], [value.deploymentFacts[0], value.deploymentFacts[0]], [{ recordId: "dp-abc12345", status: null, commitRelationship: null }]]) {
      expect(validateExplanationOutputWithDiagnostics({ ...value, deploymentFacts }, contextInput()).ok).toBe(false);
    }
    expect(validateExplanationOutputWithDiagnostics({ ...value, incidentFindings: Array.from({ length: 20 }, () => value.incidentFindings[0]) }, contextInput()).ok).toBe(false);
  });
  it("renders a recorded mismatch and CANCELLED status without inventing a running version", () => {
    const input = contextInput(); input.deploymentContext!.records[0]!.status = "CANCELLED"; input.deploymentContext!.records[0]!.commitSha = "b".repeat(40); input.deploymentContext!.records[0]!.repositoryCommitMatch = "mismatched_selected_snapshot";
    const result = validateExplanationOutputWithDiagnostics({ ...draft(), deploymentFacts: [{ recordId: "dp-abc12345", status: "CANCELLED", commitRelationship: "mismatched_selected_snapshot" }] }, input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output.observedFindings).toContainEqual({ description: "Deployment evidence: the recorded commit does not match the selected repository snapshot.", citationIds: ["dp-abc12345"] });
  });
  it("requires structured source fields in the gateway prompt and its generated JSON schema", () => {
    const prompt = buildTrustedSystemPrompt(contextInput());
    const schema = JSON.parse(outputJsonSchemaDescription(contextInput()));
    expect(prompt).toContain("It has no description or prose field");
    expect(schema.properties.deploymentFacts.items.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties.deploymentFacts.items.properties)).toEqual(["recordId", "status", "commitRelationship"]);
    expect(schema.properties).not.toHaveProperty("observedFindings");
    expect(schema.properties).not.toHaveProperty("evidenceCitations");
    expect(schema.properties).not.toHaveProperty("summary");
    expect(schema.properties).not.toHaveProperty("limitations");
  });
  it.each(["gateway", "recording"] as const)("carries the structured contract through the real %s adapter with simulated HTTP", async (kind) => {
    vi.stubEnv("THESYS_API_KEY", "offline-fixture-no-network");
    let requestBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, options?: RequestInit) => {
      requestBody = JSON.parse(String(options?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(draft()) } }], usage: { total_tokens: 10 } }));
    });
    vi.stubGlobal("fetch", fetchImpl);
    const adapter = kind === "gateway" ? createGatewayInferenceAdapter() : createRecordingGatewayAdapter({ maxOutboundAttempts: 1, fetchImpl });
    const result = await adapter.complete(contextInput());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requestBody).toHaveProperty("response_format.type", "json_object");
    expect(result).toMatchObject({ ok: true, outputContract: "source-facts-v2" });
    if (!result.ok) return;
    expect(validateExplanationOutputWithDiagnostics(result.rawJson, contextInput(), { requireStructuredSources: result.outputContract === "source-facts-v2" }).ok).toBe(true);
    const legacy = { summary: "Unknown.", observedFindings: [], evidenceCitations: [], limitations: [], missingContext: [], suggestedSteps: [] };
    expect(validateExplanationOutputWithDiagnostics(legacy, contextInput(), { requireStructuredSources: result.outputContract === "source-facts-v2" }).ok).toBe(false);
  });
});
