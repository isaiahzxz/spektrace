import { describe, expect, it } from "vitest";
import type { InvestigationModelInputV1 } from "@/lib/investigation/inference/rebuild-inference-input";
import { validateExplanationOutputWithDiagnostics } from "@/lib/investigation/inference/validate-explanation-output";

const input: InvestigationModelInputV1 = { version: 1, membershipVersion: 1, groupedIncidentCount: 1, includedEvidenceCount: 0, unavailableEvidenceCount: 0, omittedIncidentCount: 0, operation: { method: "POST", operationPath: "/payments", operationUnresolved: false }, validationOutcome: "PASSED", evidenceItems: [], fieldRegistry: [] };
function output(missingContext: string[] = []) { return { summary: "The supported body check passed; the HTTP failure remains unexplained.", observedFindings: [], evidenceCitations: [], limitations: [], missingContext, suggestedSteps: [] }; }
describe("explicit runtime evidence gaps", () => {
  it("adds the absent logs, traces, and verified runtime configuration even when the model omits them", () => {
    const raw = output();
    const result = validateExplanationOutputWithDiagnostics(raw, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output.missingContext).toEqual([
      "Request-correlated server runtime logs are not included in this evidence bundle.",
      "Request-correlated runtime traces are not included in this evidence bundle.",
      "The actual running service version and validation configuration have not been independently verified.",
    ]);
    expect(raw.missingContext).toEqual([]);
  });
  it("retains model-provided missing evidence and deduplicates identical disclosures", () => {
    const result = validateExplanationOutputWithDiagnostics(output(["Request-correlated runtime traces are not included in this evidence bundle.", "Client instrumentation was not supplied."]), input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output.missingContext).toHaveLength(4);
    expect(result.output.missingContext).toContain("Client instrumentation was not supplied.");
  });
  it("does not silently drop missing context when the enriched output exceeds its list limit", () => {
    expect(validateExplanationOutputWithDiagnostics(output(Array.from({ length: 20 }, (_, i) => `Missing item ${i}.`)), input)).toMatchObject({ ok: false, code: "OUTPUT_SCHEMA_INVALID", diagnostic: { field: "missingContext" } });
  });
});
