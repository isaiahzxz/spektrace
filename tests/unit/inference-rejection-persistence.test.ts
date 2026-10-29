import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { processInvestigationInference } from "@/server/services/process-investigation-inference";
import { rebuildInferenceInputFromPreparationRun, validateInferenceInputBeforeProvider } from "@/lib/investigation/inference/rebuild-inference-input";
import { buildContextEnrichedInferenceInput } from "@/server/investigation/build-context-enriched-input";
import { resolveInvestigationInferenceAdapter } from "@/lib/investigation/inference/resolve-adapter";
import { scheduleGroupInferenceOutbox } from "@/lib/investigation/schedule-outbox";
import { readExplanationRejectionDiagnostic } from "@/lib/investigation/inference/explanation-rejection-diagnostics";

vi.mock("@/lib/investigation/inference/rebuild-inference-input", () => ({ rebuildInferenceInputFromPreparationRun: vi.fn(), validateInferenceInputBeforeProvider: vi.fn() }));
vi.mock("@/server/investigation/build-context-enriched-input", () => ({ buildContextEnrichedInferenceInput: vi.fn() }));
vi.mock("@/lib/investigation/inference/resolve-adapter", () => ({ resolveInvestigationInferenceAdapter: vi.fn() }));
vi.mock("@/lib/investigation/schedule-outbox", () => ({ scheduleGroupInferenceOutbox: vi.fn() }));

describe("rejected explanation persistence (mocked database and provider)", () => {
  beforeEach(() => {
    vi.stubEnv("SPEKTRACE_AI_INVESTIGATION_ENABLED", "true");
    vi.stubEnv("SPEKTRACE_AI_INVESTIGATION_WORKSPACE_ID", "fixture-workspace");
    vi.stubEnv("SPEKTRACE_AI_INFERENCE_ADAPTER", "test");
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

  it.each([
    ["The response passed validation.", "UNSUPPORTED_VALIDATION_SCOPE", "response_validation_forward", "summary"],
    ["Repository code serializes amount.", "CLAIM_SOURCE_CITATION_MISMATCH", "source_citation_type", "observedFindings.description"],
    ["The deployment failed.", "OUTPUT_SCHEMA_INVALID", "output_schema", "$", true],
  ])("persists only safe rejection metadata for %s", async (text, code, rule, field, requireStructuredSources = false) => {
    const modelInput = {
      version: 1 as const, membershipVersion: 1, groupedIncidentCount: 1,
      includedEvidenceCount: 1, unavailableEvidenceCount: 0, omittedIncidentCount: 0,
      operation: { method: "POST", operationPath: "/payments", operationUnresolved: false },
      validationOutcome: "PASSED" as const,
      evidenceItems: [{
        id: "ev-abc12345", incidentId: "fixture-incident", validationStatus: "PASSED" as const,
        http: { method: "POST", statusCode: 400, operationPath: "/payments", operationPathOmissionCode: null },
        serviceRef: "svc-synthetic", specRevision: { apiSpecId: null, sourceSha256: null }, findings: [],
        protection: { evidenceComplete: true, redactionBlockedValidation: false, outputTruncated: false, omissionCodes: [] },
      }], fieldRegistry: [],
    };
    vi.mocked(rebuildInferenceInputFromPreparationRun).mockResolvedValue({
      ok: true, input: modelInput, inputHash: "fixture-hash", includedEvidenceCount: 1, unavailableEvidenceCount: 0, omittedEvidenceCount: 0,
    });
    vi.mocked(validateInferenceInputBeforeProvider).mockReturnValue({ ok: true });
    vi.mocked(buildContextEnrichedInferenceInput).mockResolvedValue({
      ok: true, input: modelInput, inputHash: "fixture-hash", repositoryExcerptRefs: [], documentationExcerptRefs: [], deploymentEvidenceRefs: [], deploymentContextFingerprint: null,
      usesDocumentation: false, usesRepository: false, usesDeployment: false,
    });
    const complete = vi.fn().mockResolvedValue({
      ok: true, provider: "offline-fixture", model: "fixture", usage: { totalTokens: 50 },
      ...(requireStructuredSources ? { outputContract: "source-facts-v2" } : {}),
      rawJson: {
        summary: field === "summary" ? text : "The supported body check passed.",
        observedFindings: [{ description: field === "summary" ? "sensitive-marker@example.invalid" : `${text} sensitive-marker@example.invalid`, citationIds: ["ev-abc12345"] }],
        evidenceCitations: [{ id: "ev-abc12345", label: "Body evidence" }], limitations: [], missingContext: [], suggestedSteps: [],
      },
    });
    vi.mocked(resolveInvestigationInferenceAdapter).mockReturnValue({
      kind: "test",
      adapter: { kind: "test", providerLabel: "offline-fixture", modelLabel: "fixture", complete },
    });
    const update = vi.fn().mockResolvedValue({});
    const runs = {
      findFirst: vi.fn().mockResolvedValue(null), count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({ id: "fixture-run" }),
      findUnique: vi.fn().mockResolvedValue({ id: "fixture-run", claimedBy: "fixture-worker", evidenceInputHash: "fixture-hash" }), update,
    };
    const incidentUpdate = vi.fn();
    const groupUpdate = vi.fn();
    const prisma = {
      evidencePreparationRun: { findFirst: vi.fn().mockResolvedValue({ id: "fixture-prep", status: "EVIDENCE_READY", membershipVersion: 1, investigationGroupId: "fixture-group", investigationGroup: {} }) },
      investigationInferenceRun: runs,
      incident: { update: incidentUpdate }, investigationGroup: { update: groupUpdate },
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({ investigationInferenceRun: runs }),
    };
    const result = await processInvestigationInference(prisma as unknown as PrismaClient, "fixture-workspace", "fixture-prep", { workerId: "fixture-worker" });
    expect(result).toEqual({ status: "processed", runId: "fixture-run", runStatus: "FAILED" });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    const persisted = update.mock.calls[0]![0].data;
    expect(persisted).toMatchObject({ status: "FAILED", failureCode: code, usageMetadata: { totalTokens: 50, explanationRejection: { version: 1, field, rule } } });
    expect(persisted.validatedOutput).toBeUndefined();
    expect(JSON.stringify(persisted)).not.toContain("sensitive-marker");
    expect(JSON.stringify(persisted)).not.toContain(text);
    expect(readExplanationRejectionDiagnostic(persisted.usageMetadata)).toMatchObject({ field, rule });
    expect(incidentUpdate).not.toHaveBeenCalled();
    expect(groupUpdate).not.toHaveBeenCalled();
    expect(scheduleGroupInferenceOutbox).not.toHaveBeenCalled();
  });
});
