import { afterAll, describe, expect, it } from "vitest";
import { ValidationStatus } from "@/generated/prisma/client";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireTestDatabaseUrl } from "@/lib/env";
import { jsonUtf8ByteLength, utf8ByteLength } from "@/lib/investigation/inference/utf8-byte-length";
import { createRecordingGatewayAdapter } from "@/lib/investigation/inference/adapters/recording-gateway-adapter";
import {
  assertVerificationDatabaseTarget,
  automatedExplanationChecksPassed,
  exitCodeForReport,
  readVerificationConfigStatus,
  runVerificationSuite,
  type VerificationReport,
} from "../../scripts/lib/real-model-verification-harness";
import { resetDatabase } from "../integration/helpers/reset-database";

describe("real-model verification harness", () => {
  it("does not report empty or failed explanation checks as passing", () => {
    expect(automatedExplanationChecksPassed([])).toBe(false);
    expect(automatedExplanationChecksPassed([{ executionSucceeded: false, explanation: null, automatedExplanationChecks: {} }])).toBe(false);
    expect(automatedExplanationChecksPassed([{ executionSucceeded: true, explanation: null, automatedExplanationChecks: { citation: "needs_human_review" } }])).toBe(false);
  });
  it("measures UTF-8 bytes beyond string length for multibyte text", () => {
    const sample = { note: "€€" };
    expect(JSON.stringify(sample).length).toBeLessThan(jsonUtf8ByteLength(sample));
    expect(utf8ByteLength("€")).toBe(3);
  });

  it("config-only status does not require THESYS_API_KEY for dry-run availability", () => {
    const status = readVerificationConfigStatus();
    expect(status.dryRunAvailable).toBe(true);
  });

  it("recording adapter validates before simulated transmission", async () => {
    const adapter = createRecordingGatewayAdapter({
      maxOutboundAttempts: 1,
      simulateProvider: true,
    });
    const bad = await adapter.complete({
      version: 1,
      membershipVersion: 1,
      groupedIncidentCount: 0,
      includedEvidenceCount: 0,
      unavailableEvidenceCount: 0,
      omittedIncidentCount: 0,
      operation: { method: "POST", operationPath: "/x", operationUnresolved: false },
      validationOutcome: ValidationStatus.MISMATCH,
      evidenceItems: [],
      fieldRegistry: [],
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) {
      return;
    }
    expect(bad.code).toBe("NO_USABLE_EVIDENCE");
    expect(adapter.state.outboundAttempts).toBe(0);
    expect(adapter.state.transmittedAfterValidation).toBe(false);
  });

  it("needs_human_review prevents treating automated checks as fully green in exit code semantics", () => {
    const report: VerificationReport = {
      mode: "dry-run",
      simulatedExternalServices: ["verify-simulated-gateway"],
      database: { target: "TEST_DATABASE_URL", databaseName: "spektrace_test", destructiveResetPerformed: true },
      providerOutboundAttempts: 3,
      maxProviderAttempts: 3,
      execution: { allCasesReachedTerminalState: true, allCasesExecutionSucceeded: true, failures: [] },
      automatedContractChecks: { allPass: true, anyFail: false, needsHumanReview: true },
      humanExplanationReview: { required: true, complete: false, note: "x" },
      realModelVerificationComplete: false,
      cases: [],
      workspaceBoundaries: { approvedIncidents: 0, activeSpecRevisions: 1, violations: [] },
    };
    expect(exitCodeForReport(report)).toBe(0);
    expect(report.realModelVerificationComplete).toBe(false);
  });

  it("refuses non-test database targets via requireTestDatabaseUrl guard", () => {
    expect(() => assertVerificationDatabaseTarget()).not.toThrow();
  });
});

describe("real-model verification harness dry-run suite", () => {
  const prisma = createPrismaClientForUrl(requireTestDatabaseUrl());

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("runs three cases with simulated gateway, valid case B 4xx, and <=3 attempts", async () => {
    const report = await runVerificationSuite(prisma, {
      mode: "dry-run",
      resetDatabase,
    });

    expect(report.mode).toBe("dry-run");
    expect(report.database.destructiveResetPerformed).toBe(true);
    expect(report.providerOutboundAttempts).toBeLessThanOrEqual(3);
    expect(report.cases).toHaveLength(3);
    expect(report.execution.allCasesExecutionSucceeded).toBe(true);
    expect(report.cases[1]?.caseId).toBe("B");
    expect(report.automatedContractChecks.anyFail).toBe(false);
    expect(report.realModelVerificationComplete).toBe(false);
    expect(report.simulatedExternalServices[0]).toContain("simulated");
  });
});
