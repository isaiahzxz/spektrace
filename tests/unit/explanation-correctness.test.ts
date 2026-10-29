import { describe, expect, it } from "vitest";
import { ValidationStatus } from "@/generated/prisma/client";
import type { InvestigationModelInputV1 } from "@/lib/investigation/inference/rebuild-inference-input";
import type { InvestigationExplanationOutputV1 } from "@/lib/investigation/inference/explanation-output-v1";
import { explanationCitationFailure } from "@/lib/investigation/inference/explanation-claim-policy";
import { validateExplanationOutput } from "@/lib/investigation/inference/validate-explanation-output";
import { buildTrustedSystemPrompt, outputJsonSchemaDescription } from "@/lib/investigation/inference/explanation-prompt-v1";

const input: InvestigationModelInputV1 = {
  version: 1, membershipVersion: 1, groupedIncidentCount: 1,
  includedEvidenceCount: 1, unavailableEvidenceCount: 0, omittedIncidentCount: 0,
  operation: { method: "POST", operationPath: "/payments", operationUnresolved: false },
  validationOutcome: ValidationStatus.MISMATCH,
  evidenceItems: [{
    id: "ev-abc12345", incidentId: "synthetic-incident", validationStatus: ValidationStatus.MISMATCH,
    http: { method: "POST", statusCode: 400, operationPath: "/payments", operationPathOmissionCode: null },
    serviceRef: "svc-synthetic", specRevision: { apiSpecId: null, sourceSha256: null },
    findings: [], protection: { evidenceComplete: true, redactionBlockedValidation: false, outputTruncated: false, omissionCodes: [] },
  }], fieldRegistry: [],
};

function explanation(): InvestigationExplanationOutputV1 {
  return {
    summary: "The supported JSON request-body check found an amount type mismatch. The incident also recorded HTTP 400; the upstream cause is unverified.",
    observedFindings: [{ description: "The amount field was a string where the request-body schema expected an integer.", citationIds: ["ev-abc12345"] }],
    evidenceCitations: [{ id: "ev-abc12345", label: "Supported JSON request-body evidence" }],
    limitations: ["Response validation was not performed. The HTTP failure remains unexplained."],
    missingContext: ["Runtime error evidence is unavailable."],
    suggestedSteps: ["Review the request-body serializer against the pinned schema."],
  };
}

describe("real-model explanation regressions", () => {
  it("gives the provider the real output schema with all source citation types", () => {
    const schema = JSON.parse(outputJsonSchemaDescription());
    const findingId = schema.properties.observedFindings.items.properties.citationIds.items;
    const catalogId = schema.properties.evidenceCitations.items.properties.id;
    const hypothesisId = schema.properties.hypotheses.items.properties.citationIds.items;
    for (const idSchema of [findingId, catalogId, hypothesisId]) {
      const pattern = new RegExp(idSchema.pattern);
      for (const prefix of ["ev-", "rx-", "dx-", "dp-"]) expect(pattern.test(`${prefix}abc12345`)).toBe(true);
      expect(pattern.test("made-up-reference")).toBe(false);
      expect(idSchema.description).toContain("not interchangeable");
    }
    expect(schema.additionalProperties).toBe(false);
  });
  it("accepts the complete captured live Case B response against passed body-check evidence", () => {
    const passedInput: InvestigationModelInputV1 = {
      ...input,
      validationOutcome: ValidationStatus.PASSED,
      evidenceItems: [{
        ...input.evidenceItems[0]!,
        incidentId: "00000000-0000-4000-8000-000000000001",
        validationStatus: ValidationStatus.PASSED,
        specRevision: { apiSpecId: "00000000-0000-4000-8000-000000000002", sourceSha256: "a".repeat(64) },
      }],
    };
    const captured: InvestigationExplanationOutputV1 = {
      summary: "The supported JSON request-body check for the POST /payments operation passed validation. The single grouped incident recorded an HTTP 400 response, but no contract violations were found in the request body fields or constraints. The cause of the HTTP 400 status remains unexplained by the available contract evidence.",
      observedFindings: [{
        description: "The POST /payments operation's supported JSON request-body validation passed with no constraint violations observed in the single grouped incident that also recorded an HTTP 400 response.",
        citationIds: ["ev-abc12345"],
      }],
      evidenceCitations: [{ id: "ev-abc12345", label: "Validation evidence for POST /payments with HTTP 400 and PASSED request-body check" }],
      hypotheses: [],
      limitations: [
        "Validation covers only the supported JSON request body; it does not include headers, authentication, response, or other parts of the API contract.",
        "The evidence does not establish the cause of the HTTP 400 response, only that the request body matched the contract constraints.",
      ],
      missingContext: [
        "Details about upstream HTTP response causes beyond request-body validation.",
        "Other parts of the request such as headers or query parameters.",
        "Server-side logs or error messages explaining the HTTP 400 response.",
      ],
      suggestedSteps: [
        "Inspect server-side logs or error messages to identify the cause of the HTTP 400 response.",
        "Verify other parts of the request and API contract beyond the JSON request body.",
        "Confirm that the request body matches the expected schema in all relevant fields and constraints.",
      ],
    };
    const result = validateExplanationOutput(JSON.stringify(captured), passedInput);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect({ ...result.output, missingContext: captured.missingContext }).toEqual(captured);
    expect(result.output.missingContext).toEqual(expect.arrayContaining([
      "Request-correlated server runtime logs are not included in this evidence bundle.",
      "Request-correlated runtime traces are not included in this evidence bundle.",
      "The actual running service version and validation configuration have not been independently verified.",
      ...captured.missingContext,
    ]));
  });

  it.each(["missingContext", "suggestedSteps"] as const)("still rejects causal assertions in %s", (field) => {
    const output = explanation();
    output[field] = ["The mismatch causes HTTP 400."];
    expect(validateExplanationOutput(output, input)).toEqual({ ok: false, code: "UNSUPPORTED_HTTP_CAUSATION" });
  });

  it("does not let a missing-context noun phrase hide a separate causal assertion", () => {
    const output = explanation();
    output.missingContext = ["Details about HTTP response causes beyond body validation which causes HTTP 400."];
    expect(validateExplanationOutput(output, input)).toEqual({ ok: false, code: "UNSUPPORTED_HTTP_CAUSATION" });
  });

  it.each([
    "The request included amount as a string, leading to a 400 Bad Request response.",
    "The amount was received as a string, resulting in a 400 HTTP response status.",
    "The field was a string, causing a validation mismatch and a 400 response.",
    "The type mismatch is the root cause of HTTP 400.",
    "The request payload included amount as a string, which does not conform to the expected integer type constraint in the API specification, leading to a 400 Bad Request response.",
  ])("rejects observed live causal wording: %s", (description) => {
    const output = explanation();
    output.hypotheses = [{ label: "Possible explanation", description, citationIds: ["ev-abc12345"] }];
    expect(validateExplanationOutput(output, input)).toEqual({ ok: false, code: "UNSUPPORTED_HTTP_CAUSATION" });
  });

  it.each([
    "The request and response conformed to the pinned OpenAPI specification.",
    "The 400 status code was not due to a contract violation.",
    "The full contract passed validation.",
  ])("rejects unsupported validation scope: %s", (description) => {
    const output = explanation();
    output.hypotheses = [{ label: "Scope claim", description, citationIds: ["ev-abc12345"] }];
    expect(validateExplanationOutput(output, input)).toEqual({ ok: false, code: "UNSUPPORTED_VALIDATION_SCOPE" });
  });

  it("checks hypothesis labels as well as descriptions", () => {
    const output = explanation();
    output.hypotheses = [{ label: "The mismatch caused HTTP 400", description: "Unverified cause.", citationIds: ["ev-abc12345"] }];
    expect(validateExplanationOutput(output, input)).toEqual({ ok: false, code: "UNSUPPORTED_HTTP_CAUSATION" });
  });

  it("rejects validation-exception advice seen in case C", () => {
    const output = explanation();
    output.suggestedSteps = ["Consider updating the API spec or adding validation exceptions if legacy decimal strings must be supported."];
    expect(validateExplanationOutput(output, input)).toEqual({ ok: false, code: "UNSUPPORTED_REMEDIATION_ADVICE" });
  });

  it("accepts co-observed status and explicit scope uncertainty", () => {
    expect(validateExplanationOutput(explanation(), input).ok).toBe(true);
  });

  it.each([
    "The cause of HTTP 400 remains unexplained.",
    "The upstream HTTP error cause is unknown.",
    "There is no evidence that the type mismatch caused HTTP 400.",
    "It is not established that the mismatch caused HTTP 400.",
  ])("does not confuse cause nouns or explicit disclaimers with causal assertions: %s", (summary) => {
    const output = explanation();
    output.summary = summary;
    expect(validateExplanationOutput(output, input).ok).toBe(true);
  });

  it("accepts a body-check pass without ruling out other failures", () => {
    const output = explanation();
    output.summary = "The supported JSON request-body check passed. The incident recorded HTTP 400; its upstream cause remains unknown.";
    output.observedFindings[0]!.description = "The supported JSON request-body check passed.";
    expect(validateExplanationOutput(output, { ...input, validationOutcome: ValidationStatus.PASSED }).ok).toBe(true);
  });

  it.each([
    "The repository code serializes amount as a string.",
    "The documentation describes decimal strings as legacy behavior.",
    "A deployment succeeded before the incident.",
  ])("requires claim-appropriate source citations: %s", (description) => {
    const output = explanation();
    output.observedFindings[0]!.description = description;
    expect(validateExplanationOutput(output, input)).toEqual({ ok: false, code: "CLAIM_SOURCE_CITATION_MISMATCH" });
  });

  it("requires source claims in the summary to have observed support", () => {
    const output = explanation();
    output.summary += " Repository code serializes amount as a string.";
    expect(validateExplanationOutput(output, input)).toEqual({ ok: false, code: "SUMMARY_CONTEXT_NOT_GROUNDED" });
  });

  it("does not let a trailing uncertainty disclaimer excuse an unrelated citation", () => {
    const output = explanation();
    output.observedFindings[0]!.description = "The repository code serializes amount as a string. Its production relationship is unknown.";
    expect(validateExplanationOutput(output, input)).toEqual({ ok: false, code: "CLAIM_SOURCE_CITATION_MISMATCH" });
  });

  it("requires hypothesis citations to appear in the display catalog", () => {
    const output = explanation();
    output.hypotheses = [{ label: "Possible serializer behavior", description: "Repository code may explain serialization shape.", citationIds: ["rx-abc12345"] }];
    expect(explanationCitationFailure(output)).toBe("CITATION_CATALOG_INCOMPLETE");
  });

  it("accepts separately cited repository and documentation facts", () => {
    const output = explanation();
    output.observedFindings.push(
      { description: "Repository code serializes amount as a string.", citationIds: ["rx-abc12345"] },
      { description: "Documentation describes legacy decimal strings; it is advisory.", citationIds: ["dx-abc12345"] },
    );
    output.evidenceCitations.push({ id: "rx-abc12345", label: "Source excerpt" }, { id: "dx-abc12345", label: "Runbook excerpt" });
    output.summary += " Repository code and documentation describe string serialization.";
    expect(explanationCitationFailure(output)).toBeNull();
  });

  it("requires summary source support in findings, not just the citation catalog or a hypothesis", () => {
    const output = explanation();
    output.summary += " Repository evidence describes string serialization.";
    output.evidenceCitations.push({ id: "rx-abc12345", label: "Source excerpt" });
    output.hypotheses = [{ label: "Possible serializer behavior", description: "Repository evidence describes string serialization.", citationIds: ["rx-abc12345"] }];
    expect(explanationCitationFailure(output)).toBe("SUMMARY_CONTEXT_NOT_GROUNDED");
  });

  it("accepts an explicitly attributed combined-context explanation without weakening source matching", () => {
    const output = explanation();
    output.summary += " Repository evidence describes string serialization. Documentation evidence is advisory. Deployment evidence provides temporal context only.";
    output.observedFindings.push(
      { description: "Repository evidence: the serializer returns a string; its runtime relationship is unverified.", citationIds: ["rx-abc12345"] },
      { description: "Documentation evidence: legacy string guidance is advisory and does not override the pinned OpenAPI.", citationIds: ["dx-abc12345"] },
      { description: "Deployment evidence: a succeeded event was recorded before the incident; timing alone does not establish causation.", citationIds: ["dp-abc12345"] },
    );
    output.evidenceCitations.push(
      { id: "rx-abc12345", label: "Source excerpt" },
      { id: "dx-abc12345", label: "Runbook excerpt" },
      { id: "dp-abc12345", label: "Status event" },
    );
    expect(explanationCitationFailure(output)).toBeNull();
    output.observedFindings[1]!.citationIds = ["ev-abc12345"];
    expect(explanationCitationFailure(output)).toBe("CLAIM_SOURCE_CITATION_MISMATCH");
  });

  it("stays conservative for a cross-source finding when no input metadata is supplied", () => {
    const output = explanation();
    output.evidenceCitations.push({ id: "rx-abc12345", label: "Source excerpt" }, { id: "dp-abc12345", label: "Status event" });
    output.observedFindings.push({ description: "Deployment evidence: its recorded commit matches the selected repository snapshot; this does not establish incident causation.", citationIds: ["dp-abc12345"] });
    expect(explanationCitationFailure(output)).toBe("CLAIM_SOURCE_CITATION_MISMATCH");
    output.observedFindings.at(-1)!.citationIds.push("rx-abc12345");
    expect(explanationCitationFailure(output)).toBeNull();
  });

  it("keeps the prompt explicit about body-only scope and source citations", () => {
    const prompt = buildTrustedSystemPrompt();
    expect(prompt).toContain("ONLY the supported JSON request body");
    expect(prompt).toContain("incident citations cannot support those external source facts");
    expect(prompt).toContain("validation exceptions");
    expect(prompt).toContain("begin its description with Repository evidence:");
    expect(prompt).toContain("not merely to the citation catalog or a hypothesis");
    expect(prompt).toContain("Do not invent findings");
    expect(prompt).not.toContain("must cite both the supplied dp- event and rx- excerpt");
    expect(prompt).toContain("do not add causal theories or causal questions to suggestedSteps");
    expect(prompt).toContain("in separate observedFindings");
    expect(prompt).toContain("A dp- citation supports deployment metadata, not what a repository snapshot contains");
    expect(prompt).toContain("If missing, unknown, or inconsistent, omit the comparison");
    expect(prompt).toContain("Do not append containing the serialization function");
    expect(prompt).toContain("Put the deployment causation caveat separately in limitations");
  });
});
