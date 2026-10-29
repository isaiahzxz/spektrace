import { config as loadEnv } from "dotenv";
import { createHash, randomUUID } from "node:crypto";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireTestDatabaseUrl } from "@/lib/env";
import { assertVerificationDatabaseTarget } from "./lib/real-model-verification-harness";
import { registerApiSpec, activateApiSpecRevision } from "@/server/repositories/api-specs";
import { submitIncident } from "@/server/services/incident-submission";
import { processIncidentValidation } from "@/server/services/process-incident-validation";
import { generatePayloadProposal } from "@/server/review/payload-proposal";

loadEnv({ quiet: true });
async function main() {
  if (process.argv.slice(2).join(" ") !== "--simulate") throw new Error("This verification supports --simulate only");
  const target = assertVerificationDatabaseTarget();
  const db = createPrismaClientForUrl(requireTestDatabaseUrl());
  const oldAi = process.env.SPEKTRACE_AI_INVESTIGATION_ENABLED;
  process.env.SPEKTRACE_AI_INVESTIGATION_ENABLED = "false";
  try {
    const incidentFields = { id: true, status: true, sanitizedRequestBody: true, validationStatus: true, validationEvidence: true, approvedAt: true } as const;
    const specFields = { id: true, isActive: true, sourceSha256: true } as const;
    const beforeIncidents = await db.incident.findMany({ orderBy: { id: "asc" }, select: incidentFields });
    const beforeSpecs = await db.apiSpec.findMany({ orderBy: { id: "asc" }, select: specFields });
    const cases = [];
    for (const scenario of [{ name: "canonical integer string", amount: "100", expected: "ready" }, { name: "decimal string requires human input", amount: "12.5", expected: "needs_human_input" }, { name: "passing body check needs no correction", amount: 100, expected: "needs_human_input" }] as const) {
      const workspace = await db.workspace.create({ data: { name: "Synthetic payload proposal verification", slug: `proposal-${randomUUID()}` } });
      const document = { openapi: "3.1.0", paths: { "/payments": { post: { requestBody: { content: { "application/json": { schema: { type: "object", required: ["amount"], properties: { amount: { type: "integer" } } } } } } } } } };
      const sourceText = JSON.stringify(document);
      const spec = await registerApiSpec(db, { workspaceId: workspace.id, apiKey: "payments-api", name: "Synthetic payments", version: "1.0.0", openApiVersion: "3.1.0", sourceFilename: "synthetic.json", sourceText, sourceSha256: createHash("sha256").update(sourceText).digest("hex"), parsedDocument: document });
      await activateApiSpecRevision(db, workspace.id, spec.id);
      const submitted = await submitIncident(db, workspace.id, { source: "WEBHOOK", sourceEventId: randomUUID(), apiKey: "payments-api", httpMethod: "POST", requestPath: "/payments", statusCode: 400, occurredAt: new Date().toISOString(), sanitizedRequestBody: { amount: scenario.amount } });
      await processIncidentValidation(db, workspace.id, submitted.incident.id);
      const before = JSON.stringify(await db.incident.findFirst({ where: { workspaceId: workspace.id, id: submitted.incident.id } }));
      let simulatedCalls = 0;
      const result = await generatePayloadProposal(db, workspace.id, submitted.incident.id, { provider: "offline-simulation", model: "deterministic-plan-fixture", async propose(input) { simulatedCalls++; return { decision: "propose", operation: "canonical_integer_string_to_integer", findingIndex: input.findings[0]!.findingIndex, jsonPointer: input.findings[0]!.jsonPointer }; } });
      const unchanged = before === JSON.stringify(await db.incident.findFirst({ where: { workspaceId: workspace.id, id: submitted.incident.id } }));
      cases.push({ scenario: scenario.name, result, simulatedCalls, incidentUnchanged: unchanged });
      if (result.status !== scenario.expected || !unchanged || simulatedCalls !== (scenario.expected === "ready" ? 1 : 0)) throw new Error("Synthetic proposal check failed");
    }
    const afterIncidents = await db.incident.findMany({ where: { id: { in: beforeIncidents.map((row) => row.id) } }, orderBy: { id: "asc" }, select: incidentFields });
    const afterSpecs = await db.apiSpec.findMany({ where: { id: { in: beforeSpecs.map((row) => row.id) } }, orderBy: { id: "asc" }, select: specFields });
    const existingRecordsUnchanged = JSON.stringify(beforeIncidents) === JSON.stringify(afterIncidents) && JSON.stringify(beforeSpecs) === JSON.stringify(afterSpecs);
    console.log(JSON.stringify({ mode: "simulated-model-real-test-database", databaseName: target.databaseName, databaseResetPerformed: false, realProviderCalls: 0, existingRecordsUnchanged, cases, humanReviewComplete: false }, null, 2));
    if (!existingRecordsUnchanged) process.exitCode = 3;
  } finally { if (oldAi === undefined) delete process.env.SPEKTRACE_AI_INVESTIGATION_ENABLED; else process.env.SPEKTRACE_AI_INVESTIGATION_ENABLED = oldAi; await db.$disconnect(); }
}
main().catch(() => { console.error("Synthetic payload proposal verification failed. No automatic retry was run."); process.exitCode = 1; });
