import { describe, expect, it } from "vitest";
import { ValidationStatus } from "@/generated/prisma/client";
import { INVESTIGATION_INFERENCE_LIMITS } from "@/lib/investigation/inference/config";
import { createRecordingGatewayAdapter } from "@/lib/investigation/inference/adapters/recording-gateway-adapter";
import type { InvestigationModelInputV1 } from "@/lib/investigation/inference/rebuild-inference-input";
import { randomUUID } from "node:crypto";

function minimalInput(overrides?: Partial<InvestigationModelInputV1>): InvestigationModelInputV1 {
  return {
    version: 1,
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
    ...overrides,
  };
}

describe("recording gateway adapter", () => {
  it("does not call fetch when outbound validation fails", async () => {
    let fetchCalls = 0;
    const adapter = createRecordingGatewayAdapter({
      maxOutboundAttempts: 3,
      simulateProvider: false,
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response("{}");
      },
    });
    const result = await adapter.complete(minimalInput({ includedEvidenceCount: 0, evidenceItems: [] }));
    expect(result.ok).toBe(false);
    expect(fetchCalls).toBe(0);
    expect(adapter.state.transmittedAfterValidation).toBe(false);
  });

  it("enforces max outbound attempts at the adapter boundary", async () => {
    const adapter = createRecordingGatewayAdapter({
      maxOutboundAttempts: 2,
      simulateProvider: true,
    });
    await adapter.complete(minimalInput());
    await adapter.complete(minimalInput());
    const third = await adapter.complete(minimalInput());
    expect(third.ok).toBe(false);
    if (third.ok) {
      return;
    }
    expect(third.code).toBe("VERIFY_ATTEMPT_BUDGET_EXCEEDED");
    expect(adapter.state.outboundAttempts).toBe(2);
  });

  it("rejects oversized provider JSON content by UTF-8 bytes", async () => {
    process.env.THESYS_API_KEY = "test-key-not-used-for-network";
    const huge = "x".repeat(INVESTIGATION_INFERENCE_LIMITS.maxOutputUtf8Bytes + 10);
    const adapter = createRecordingGatewayAdapter({
      maxOutboundAttempts: 1,
      simulateProvider: false,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ summary: huge }) } }],
          }),
        ),
    });
    const result = await adapter.complete(minimalInput());
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe("GATEWAY_RESPONSE_SIZE_EXCEEDED");
    delete process.env.THESYS_API_KEY;
  });
});
