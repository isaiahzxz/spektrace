import { describe, expect, it, vi, beforeEach } from "vitest";
import { request } from "node:http";
import { createSyntheticReviewGate, selectScreenedRejectionSentence, startLocalSentenceReview } from "../../scripts/lib/synthetic-local-review";
import type { SyntheticCaseCFixture } from "../../scripts/lib/real-model-verification-harness";
import type { InvestigationModelInputV1 } from "@/lib/investigation/inference/rebuild-inference-input";
import type { ExplanationRejectionDiagnostic } from "@/lib/investigation/inference/explanation-rejection-diagnostics";
import { sourceCheckDetails } from "@/lib/investigation/inference/source-check-details";
import { isFreshSyntheticCaseCInput } from "../../scripts/lib/real-model-verification-harness";
vi.mock("../../scripts/lib/real-model-verification-harness", async (original) => ({ ...await original<object>(), isFreshSyntheticCaseCInput: vi.fn(() => false) }));
beforeEach(() => { vi.mocked(isFreshSyntheticCaseCInput).mockReturnValue(false); });

const input: InvestigationModelInputV1 = { version: 1, membershipVersion: 1, groupedIncidentCount: 1, includedEvidenceCount: 0, unavailableEvidenceCount: 0, omittedIncidentCount: 0, operation: { method: "POST", operationPath: "/payments", operationUnresolved: false }, validationOutcome: "PASSED", evidenceItems: [], fieldRegistry: [] };
const diagnostic: ExplanationRejectionDiagnostic = { version: 1, field: "observedFindings.description", itemIndex: 0, rule: "source_citation_type", requiredCitationPrefix: "rx-" };
function output(description = "Repository code serializes the amount. Another unrelated sentence.") {
  return { summary: "The body check passed.", observedFindings: [{ description, citationIds: ["rx-abc12345"] }], evidenceCitations: [{ id: "rx-abc12345", label: "Repository" }], limitations: [], missingContext: [], suggestedSteps: [] };
}
function authorizedReview() {
  // Only fixture authorization is stubbed; screening and the HTTP server run unchanged.
  vi.mocked(isFreshSyntheticCaseCInput).mockReturnValueOnce(true);
  const gate = createSyntheticReviewGate({ input } as SyntheticCaseCFixture, true);
  gate.capture(output(), diagnostic, input);
  const review = gate.take()!;
  expect(gate.take()).toBeNull();
  return review;
}
function get(url: string, headers: Record<string, string> = {}, method = "GET") {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const req = request(url, { headers, method }, (response) => { let body = ""; response.setEncoding("utf8"); response.on("data", (chunk) => { body += chunk; }); response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body })); });
    req.on("error", reject); req.end();
  });
}
describe("synthetic rejection review", () => {
  it("screens structured prose even when source-scope validation rejects it", () => {
    const raw = { version: 2, incidentFindings: [{ evidenceId: "ev-abc12345" }], repositoryObservations: [{ excerptId: "rx-abc12345", description: "The body check passed. Deployment context adds information." }], documentationObservations: [], deploymentFacts: [], missingContext: [], manualReviewChecks: [] };
    const location: ExplanationRejectionDiagnostic = { version: 1, field: "repositoryObservations", itemIndex: 0, rule: "structured_source_scope" };
    const review = selectScreenedRejectionSentence(raw, location, input);
    expect(review?.sentence).toBe("Deployment context adds information.");
    expect(review?.citationRefs).toEqual([]);
    expect(selectScreenedRejectionSentence({ ...raw, repositoryObservations: [{ description: "Deployment contact person@example.invalid.", excerptId: "rx-abc12345" }] }, location, input)).toBeNull();
    expect(selectScreenedRejectionSentence({ ...raw, privateExtra: "secret" }, location, input)).toBeNull();
  });
  it("selects one candidate sentence and excludes unknown citation references", () => {
    const review = selectScreenedRejectionSentence(output(), diagnostic, input)!;
    expect(review.sentence).toBe("Repository code serializes the amount.");
    expect(review.citationRefs).toEqual([]);
    expect(review.selection).toBe("candidate_source_sentence");
    expect(Object.isFrozen(review)).toBe(true);
  });
  it.each(["Repository contact is person@example.invalid.", "Repository token is Bearer abcdefghijklmnopqrstuvwxyz.", "Repository number is 4111111111111111.", "Repository <script>alert(1)</script>.", `Repository ${"€".repeat(450)}.`])("refuses unsafe or oversized candidate: %s", (text) => {
    expect(selectScreenedRejectionSentence(output(text), diagnostic, input)).toBeNull();
  });
  it("refuses a known credential value and malformed output", () => {
    expect(selectScreenedRejectionSentence(output("Repository contains exact-private-marker."), diagnostic, input, ["exact-private-marker"])).toBeNull();
    expect(selectScreenedRejectionSentence({ private: "data" }, diagnostic, input)).toBeNull();
  });
  it.each([false, true])("does not grant review to a forged or cloned fixture, enabled=%s", (enabled) => {
    const gate = createSyntheticReviewGate({ input } as SyntheticCaseCFixture, enabled);
    gate.capture(output(), diagnostic, input);
    expect(gate.take()).toBeNull();
  });
  it("does not accept a forged or cloned screened payload", async () => {
    const review = selectScreenedRejectionSentence(output(), diagnostic, input)!;
    await expect(startLocalSentenceReview({ ...review })).rejects.toThrow("Unscreened");
    await expect(startLocalSentenceReview(review)).rejects.toThrow("Unscreened");
    await expect(startLocalSentenceReview(authorizedReview(), 300001)).rejects.toThrow("bounds");
  });
  it("serves plaintext without caching only at its loopback token and blocks cross-origin access", async () => {
    const review = authorizedReview();
    const viewer = await startLocalSentenceReview(review, 1000);
    try {
      const response = await get(viewer.url);
      expect(response.status).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["content-type"]).toContain("text/plain");
      expect(response.body).toContain(review.sentence);
      expect((await get(viewer.url, { Origin: "https://example.invalid" })).status).toBe(404);
      expect((await get(viewer.url, { Host: "example.invalid" })).status).toBe(404);
      expect((await get(viewer.url, { "Sec-Fetch-Site": "cross-site" })).status).toBe(404);
      expect((await get(viewer.url, {}, "POST")).status).toBe(404);
      expect((await get(viewer.url.replace(/\/review\/.*/, "/review/wrong"))).status).toBe(404);
    } finally { viewer.close(); }
    await expect(startLocalSentenceReview(review)).rejects.toThrow("Unscreened");
    await expect(get(viewer.url)).rejects.toThrow();
  });
  it("automatically closes after its bounded lifetime", async () => {
    const viewer = await startLocalSentenceReview(authorizedReview(), 50);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(get(viewer.url)).rejects.toThrow();
  });
  it("keeps source diagnostics text-free and differentiates atomic, mixed, and unknown wording", () => {
    const atomic = "The recorded deployment commit matches the selected repository snapshot.";
    const a = sourceCheckDetails(atomic, ["dp-private-reference"], input, ["rx-"]);
    expect(a).toMatchObject({ recognition: "atomic_only", recognizedStatements: 1, providedCitationPrefixes: ["dp-"], comparisonEvidence: { selectedSnapshot: "missing", citedDeployments: "unknown", verification: "unsupported" } });
    expect(sourceCheckDetails(`${atomic} Repository code serializes amount.`, [], input, ["rx-"]).recognition).toBe("mixed");
    expect(sourceCheckDetails("Repository private-marker.", [], input, ["rx-"]).recognition).toBe("none");
    expect(JSON.stringify(a)).not.toContain("private-reference");
    expect(JSON.stringify(a)).not.toContain(atomic);
  });
});
