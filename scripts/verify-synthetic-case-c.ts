import { config as loadEnv } from "dotenv";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireTestDatabaseUrl } from "@/lib/env";
import { createRecordingGatewayAdapter } from "@/lib/investigation/inference/adapters/recording-gateway-adapter";
import { setHarnessInferenceAdapter } from "@/lib/investigation/inference/adapters/harness-inference-slot";
import { validateExplanationOutputWithDiagnostics } from "@/lib/investigation/inference/validate-explanation-output";
import { readExplanationRejectionDiagnostic, readInferenceTokenUsage } from "@/lib/investigation/inference/explanation-rejection-diagnostics";
import { processInvestigationInference } from "@/server/services/process-investigation-inference";
import { assertVerificationDatabaseTarget, createFreshSyntheticCase, readVerificationConfigStatus } from "./lib/real-model-verification-harness";
import { createSyntheticReviewGate, startLocalSentenceReview } from "./lib/synthetic-local-review";
import { parseSyntheticCaseOptions } from "./lib/synthetic-case-options";

loadEnv({ quiet: true });
const envKeys = ["SPEKTRACE_AI_INVESTIGATION_ENABLED", "SPEKTRACE_AI_INVESTIGATION_WORKSPACE_ID", "SPEKTRACE_AI_INFERENCE_ADAPTER", "SPEKTRACE_EVIDENCE_PREPARATION_ENABLED", "SPEKTRACE_REPOSITORY_IMPORT_ALLOWLIST", "SPEKTRACE_DOCUMENTATION_IMPORT_ALLOWLIST", "SPEKTRACE_DEPLOYMENT_IMPORT_ALLOWLIST"] as const;

async function main() {
  const options = parseSyntheticCaseOptions(process.argv.slice(2));
  const configuration = readVerificationConfigStatus();
  if (options.configOnly) {
    console.log(JSON.stringify({ ...configuration, caseId: options.caseId, providerOutboundAttempts: 0, databaseAccessed: false, databaseResetPerformed: false, maxProviderAttempts: 1, localReviewEnabled: options.reviewRejection }, null, 2));
    process.exitCode = configuration.readyForLiveGateway ? 0 : 2;
    return;
  }
  if (!configuration.readyForLiveGateway) throw new Error("Live gateway configuration is incomplete; use --config-only");
  const target = assertVerificationDatabaseTarget();
  const prisma = createPrismaClientForUrl(requireTestDatabaseUrl());
  const priorEnv = envKeys.map((key) => process.env[key]);
  const adapter = createRecordingGatewayAdapter({ maxOutboundAttempts: 1 });
  try {
    const beforeIncidents = await prisma.incident.findMany({ orderBy: { id: "asc" }, select: { id: true, validationStatus: true, validationEvidence: true, approvedAt: true } });
    const beforeSpecs = await prisma.apiSpec.findMany({ orderBy: { id: "asc" }, select: { id: true, isActive: true } });
    const fixture = await createFreshSyntheticCase(prisma, options.caseId);
    const reviewGate = createSyntheticReviewGate(fixture, options.reviewRejection);
    const snapshot = async () => ({
      incident: await prisma.incident.findFirst({ where: { id: fixture.incidentId, workspaceId: fixture.workspaceId }, select: { validationStatus: true, validationEvidence: true, approvedAt: true } }),
      spec: await prisma.apiSpec.findFirst({ where: { id: fixture.specId, workspaceId: fixture.workspaceId }, select: { isActive: true } }),
    });
    const before = await snapshot();
    setHarnessInferenceAdapter({ ...adapter, async complete(input) {
      const response = await adapter.complete(input);
      if (!response.ok) return { ...response, retryable: false };
      if (response.ok) {
        const validation = validateExplanationOutputWithDiagnostics(response.rawJson, input, { requireStructuredSources: response.outputContract === "source-facts-v2" });
        if (!validation.ok) reviewGate.capture(response.rawJson, validation.diagnostic, input, [process.env.THESYS_API_KEY ?? ""]);
      }
      return response;
    } });
    const processed = await processInvestigationInference(prisma, fixture.workspaceId, fixture.prepId, {
      repositoryContextSnapshotId: fixture.repositoryContextSnapshotId,
      documentationContextSnapshotId: fixture.documentationContextSnapshotId,
      includeDeploymentContext: options.caseId === "C",
    });
    const run = processed.status === "processed" ? await prisma.investigationInferenceRun.findFirst({ where: { id: processed.runId, workspaceId: fixture.workspaceId } }) : null;
    const after = await snapshot();
    const afterIncidents = await prisma.incident.findMany({ where: { id: { in: beforeIncidents.map((row) => row.id) } }, orderBy: { id: "asc" }, select: { id: true, validationStatus: true, validationEvidence: true, approvedAt: true } });
    const afterSpecs = await prisma.apiSpec.findMany({ where: { id: { in: beforeSpecs.map((row) => row.id) } }, orderBy: { id: "asc" }, select: { id: true, isActive: true } });
    const existingRecordsUnchanged = JSON.stringify(beforeIncidents) === JSON.stringify(afterIncidents) && JSON.stringify(beforeSpecs) === JSON.stringify(afterSpecs);
    const fixtureBoundariesUnchanged = JSON.stringify(before) === JSON.stringify(after);
    const queuedInferenceEvents = await prisma.outboxEvent.count({ where: { workspaceId: fixture.workspaceId, eventType: "INVESTIGATION_GROUP_INFERENCE_REQUESTED" } });
    const sentence = reviewGate.take();
    const viewer = sentence ? await startLocalSentenceReview(sentence) : null;
    const result = {
      mode: "live-gateway", caseId: options.caseId, databaseName: target.databaseName, databaseResetPerformed: false,
      maxProviderAttempts: 1, providerOutboundAttempts: adapter.state.outboundAttempts, newSyntheticWorkspaceCreated: true,
      status: run?.status ?? processed.status, failureCode: run?.failureCode ?? null,
      rejectionDiagnostic: readExplanationRejectionDiagnostic(run?.usageMetadata),
      provider: run?.provider, model: run?.model, promptSchemaVersion: run?.promptSchemaVersion,
      evidenceInputHash: run?.evidenceInputHash, usage: readInferenceTokenUsage(run?.usageMetadata),
      explanation: run?.validatedOutput ?? null,
      localReview: { enabled: options.reviewRejection, available: viewer !== null, url: viewer?.url ?? null, expiresAt: viewer?.expiresAt ?? null, textPersisted: false },
      existingRecordsUnchanged, fixtureBoundariesUnchanged, queuedInferenceEvents, humanReviewComplete: false,
    };
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = run?.status === "SUCCEEDED" && existingRecordsUnchanged && fixtureBoundariesUnchanged && queuedInferenceEvents === 0 && adapter.state.outboundAttempts === 1 ? 0 : 3;
  } finally {
    setHarnessInferenceAdapter(null);
    envKeys.forEach((key, index) => { if (priorEnv[index] === undefined) delete process.env[key]; else process.env[key] = priorEnv[index]; });
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  // Do not print provider output, connection strings, or arbitrary thrown messages.
  console.error(JSON.stringify({ status: "CHECK_FAILED", errorType: error instanceof Error ? error.name : "UnknownError", message: "Synthetic check failed; no automatic retry was run." }));
  process.exitCode = 1;
});
