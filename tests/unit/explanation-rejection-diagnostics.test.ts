import { describe, expect, it } from "vitest";
import type { InvestigationModelInputV1 } from "@/lib/investigation/inference/rebuild-inference-input";
import type { InvestigationExplanationOutputV1 } from "@/lib/investigation/inference/explanation-output-v1";
import { validateExplanationOutput, validateExplanationOutputWithDiagnostics } from "@/lib/investigation/inference/validate-explanation-output";
import { explanationRejectionDiagnosticSchema, readExplanationRejectionDiagnostic, readInferenceTokenUsage } from "@/lib/investigation/inference/explanation-rejection-diagnostics";

const input: InvestigationModelInputV1 = {
  version: 1, membershipVersion: 1, groupedIncidentCount: 1,
  includedEvidenceCount: 1, unavailableEvidenceCount: 0, omittedIncidentCount: 0,
  operation: { method: "POST", operationPath: "/payments", operationUnresolved: false },
  validationOutcome: "PASSED", evidenceItems: [], fieldRegistry: [],
};

function output(): InvestigationExplanationOutputV1 {
  return {
    summary: "The supported body check passed; the HTTP 400 cause remains unknown.",
    observedFindings: [], evidenceCitations: [], limitations: [], missingContext: [], suggestedSteps: [],
  };
}

describe("safe explanation rejection diagnostics", () => {
  it.each([
    ["The response passed validation.", "response_validation_forward"],
    ["Validation passed for the entire contract.", "response_validation_reverse"],
    ["HTTP 400 was not due to a contract violation.", "http_contract_exclusion"],
    ["The mismatch causes HTTP 400.", "http_causation"],
    ["Add validation exceptions.", "unsafe_remediation"],
  ])("identifies the exact claim rule without retaining its text: %s", (text, rule) => {
    const fixture = output();
    fixture.missingContext = ["Missing runtime logs.", `sensitive-marker@example.invalid. ${text}`];
    const result = validateExplanationOutputWithDiagnostics(fixture, input);
    expect(result).toMatchObject({ ok: false, diagnostic: { version: 1, field: "missingContext", itemIndex: 1, clauseIndex: 1, rule } });
    expect(JSON.stringify(result)).not.toContain("sensitive-marker");
    expect(JSON.stringify(result)).not.toContain(text);
    expect(JSON.stringify(result).length).toBeLessThan(512);
  });

  it("locates a source-type mismatch within the second observed finding", () => {
    const fixture = output();
    fixture.evidenceCitations = [{ id: "ev-abc12345", label: "Body evidence" }];
    fixture.observedFindings = [
      { description: "Body check passed.", citationIds: ["ev-abc12345"] },
      { description: "Repository code serializes the amount.", citationIds: ["ev-abc12345"] },
    ];
    const evidenceInput = { ...input, evidenceItems: [{ id: "ev-abc12345" } as InvestigationModelInputV1["evidenceItems"][number]] };
    expect(validateExplanationOutputWithDiagnostics(fixture, evidenceInput)).toMatchObject({
      ok: false, code: "CLAIM_SOURCE_CITATION_MISMATCH",
      diagnostic: { version: 1, field: "observedFindings.description", itemIndex: 1, rule: "source_citation_type", requiredCitationPrefix: "rx-" },
    });
  });

  it("locates hypothesis labels separately from their descriptions", () => {
    const fixture = output();
    fixture.hypotheses = [{ label: "Mismatch caused HTTP 400", description: "Unknown.", citationIds: [] }];
    expect(validateExplanationOutputWithDiagnostics(fixture, input)).toMatchObject({
      ok: false, diagnostic: { field: "hypotheses.label", itemIndex: 0, rule: "http_causation" },
    });
  });

  it("does not export an unrecognized citation value", () => {
    const fixture = output();
    fixture.evidenceCitations = [{ id: "ev-deadbeef", label: "sensitive label" }];
    expect(validateExplanationOutputWithDiagnostics(fixture, input)).toEqual({
      ok: false, code: "UNKNOWN_CITATION_ID",
      diagnostic: { version: 1, field: "evidenceCitations.id", itemIndex: 0, rule: "unknown_citation" },
    });
  });

  it("locates forbidden advice without including the match", () => {
    const fixture = output();
    fixture.suggestedSteps = ["Use this corrected payload containing sensitive-marker."];
    expect(validateExplanationOutputWithDiagnostics(fixture, input)).toEqual({
      ok: false, code: "FORBIDDEN_OUTPUT_CONTENT",
      diagnostic: { version: 1, field: "suggestedSteps", itemIndex: 0, rule: "forbidden_output_pattern", patternIndex: 0 },
    });
  });

  it("maps schema issues only to known field names", () => {
    expect(validateExplanationOutputWithDiagnostics({ ...output(), missingContext: [123] }, input)).toMatchObject({
      ok: false, diagnostic: { field: "missingContext", itemIndex: 0, rule: "output_schema" },
    });
    const result = validateExplanationOutputWithDiagnostics({ ...output(), "sensitive-key@example.invalid": "secret" }, input);
    expect(result).toEqual({ ok: false, code: "OUTPUT_SCHEMA_INVALID", diagnostic: { version: 1, field: "$", rule: "output_schema" } });
  });

  it.each(["not JSON secret", JSON.stringify({ ...output(), summary: "€".repeat(40_000) })])("keeps syntax and size failures text-free", (raw) => {
    const result = validateExplanationOutputWithDiagnostics(raw, input);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result).length).toBeLessThan(512);
  });

  it("preserves the legacy return shape and emits no diagnostic on success", () => {
    const fixture = output();
    expect(validateExplanationOutputWithDiagnostics(fixture, input)).toEqual({ ok: true, output: { ...fixture, missingContext: [
      "Request-correlated server runtime logs are not included in this evidence bundle.",
      "Request-correlated runtime traces are not included in this evidence bundle.",
      "The actual running service version and validation configuration have not been independently verified.",
    ] } });
    fixture.summary = "Mismatch caused HTTP 400.";
    expect(validateExplanationOutput(fixture, input)).toEqual({ ok: false, code: "UNSUPPORTED_HTTP_CAUSATION" });
  });

  it("rejects extra diagnostic fields, unknown rules, untrusted paths, and unbounded indices", () => {
    const diagnostic = { version: 1, field: "summary", rule: "http_causation" };
    for (const invalid of [
      { ...diagnostic, excerpt: "secret" }, { ...diagnostic, rule: "secret" },
      { ...diagnostic, field: "secret@example.invalid" }, { ...diagnostic, itemIndex: 500 },
      { ...diagnostic, clauseIndex: -1 }, { ...diagnostic, requiredCitationPrefix: "secret" },
      { ...diagnostic, version: 2 },
    ]) {
      expect(explanationRejectionDiagnosticSchema.safeParse(invalid).success).toBe(false);
      expect(readExplanationRejectionDiagnostic({ explanationRejection: invalid })).toBeNull();
    }
    expect(readExplanationRejectionDiagnostic({ explanationRejection: diagnostic })).toEqual(diagnostic);
    expect(readExplanationRejectionDiagnostic(null)).toBeNull();
    expect(readExplanationRejectionDiagnostic({ gatewayErrorDiagnostics: { secret: "value" } })).toBeNull();
  });

  it("keeps token counts separate from rejection diagnostics and arbitrary metadata", () => {
    expect(readInferenceTokenUsage({ totalTokens: 9, promptTokens: "secret", completionTokens: -1, rawJson: "secret" })).toEqual({ totalTokens: 9 });
    expect(readInferenceTokenUsage({ explanationRejection: { field: "summary" } })).toBeNull();
    expect(readInferenceTokenUsage(null)).toBeNull();
  });
});
