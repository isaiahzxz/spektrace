import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ValidationStatus } from "@/generated/prisma/client";
import { validateExplanationOutput } from "@/lib/investigation/inference/validate-explanation-output";
import type { InvestigationModelInputV4 } from "@/lib/investigation/inference/rebuild-inference-input";

function baseV4Input(): InvestigationModelInputV4 {
  return {
    version: 4,
    membershipVersion: 1,
    groupedIncidentCount: 1,
    includedEvidenceCount: 1,
    unavailableEvidenceCount: 0,
    omittedIncidentCount: 0,
    operation: { method: "POST", operationPath: "/payments", operationUnresolved: false },
    validationOutcome: ValidationStatus.MISMATCH,
    evidenceItems: [
      {
        id: "ev-abc12345",
        incidentId: randomUUID(),
        validationStatus: ValidationStatus.MISMATCH,
        http: {
          method: "POST",
          statusCode: 400,
          operationPath: "/payments",
          operationPathOmissionCode: null,
        },
        serviceRef: "svc-abc",
        specRevision: { apiSpecId: null, sourceSha256: null },
        findings: [],
        protection: {
          evidenceComplete: true,
          redactionBlockedValidation: false,
          outputTruncated: false,
          omissionCodes: [],
        },
      },
    ],
    fieldRegistry: [],
    deploymentContext: {
      referenceOccurredAt: "2026-01-15T12:00:00.000Z",
      lookbackMs: 7 * 24 * 60 * 60 * 1000,
      records: [
        {
          id: "dp-abc1234567",
          sourceDeploymentRef: "dep-abc123456789",
          status: "SUCCEEDED",
          sourceReportedAt: "2026-01-15T10:05:00.000Z",
          receivedAt: "2026-01-15T10:06:00.000Z",
          repository: "synthetic/example",
          commitSha: "abc1234567890abcdef1234567890abcdef12345678",
          artifactRef: "payments-api:1.0.0",
          apiSpecId: null,
          runningVersionAssessment: "single_candidate",
          repositoryCommitMatch: "unknown",
          retrievalMethod: "temporal_window:latest_status_at_reference",
          limitations: ["Temporal proximity is not causation."],
        },
      ],
      missingContext: [],
      limitations: ["Temporal proximity is not causation."],
    },
  };
}

describe("deployment context citation validation", () => {
  it("rejects unknown deployment record citations", () => {
    const input = baseV4Input();
    const validated = validateExplanationOutput(
      {
        summary: "deployment cite",
        observedFindings: [{ description: "bad", citationIds: ["dp-deadbeef00"] }],
        evidenceCitations: [{ id: "dp-deadbeef00", label: "bad" }],
        limitations: ["l"],
        missingContext: ["m"],
        suggestedSteps: ["s"],
      },
      input,
    );
    expect(validated.ok).toBe(false);
    if (validated.ok) {
      return;
    }
    expect(validated.code).toBe("UNKNOWN_CITATION_ID");
  });

  it("rejects forbidden causal deployment language", () => {
    const input = baseV4Input();
    const validated = validateExplanationOutput(
      {
        summary: "This deployment caused the production failure.",
        observedFindings: [{ description: "x", citationIds: ["dp-abc1234567"] }],
        evidenceCitations: [{ id: "dp-abc1234567", label: "deploy" }],
        limitations: ["l"],
        missingContext: ["m"],
        suggestedSteps: ["s"],
      },
      input,
    );
    expect(validated.ok).toBe(false);
    if (validated.ok) {
      return;
    }
    expect(validated.code).toBe("FORBIDDEN_OUTPUT_CONTENT");
  });
});
