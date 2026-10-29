import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireTestDatabaseUrl } from "@/lib/env";
import { sanitizeSyntheticWebhook } from "@/lib/ingestion/synthetic-webhook";
import { acceptSyntheticWebhook } from "@/server/services/accept-synthetic-webhook";
import { issueIngestionCredential } from "@/server/services/ingestion-credentials";
import { processWebhookValidation } from "@/server/services/process-webhook-validation";
import { listWebhookReceipts, loadWebhookReceipt } from "@/server/dashboard/webhook-receipts";

const url = requireTestDatabaseUrl();
if (new URL(url).pathname.slice(1) !== process.env.SPEKTRACE_HISTORICAL_VERIFY_DATABASE ||
  !/^spektrace_test_history_[a-f0-9]{32}$/.test(process.env.SPEKTRACE_HISTORICAL_VERIFY_DATABASE ?? "")) throw new Error("Use disposable webhook-view verification");
const db = createPrismaClientForUrl(url); afterAll(() => db.$disconnect());
async function fixture() {
  const workspace = await db.workspace.create({ data: { name: "Synthetic receipt review", slug: `receipt-view-${randomUUID()}` } });
  const key = await issueIngestionCredential(db, workspace.id, "Synthetic review collector");
  const document = { openapi: "3.1.0", paths: { "/payments": { post: { requestBody: { content: { "application/json": { schema: {
    type: "object", required: ["amount"], properties: { amount: { type: "integer" } },
  } } } } } } } }; const source = JSON.stringify(document);
  const spec = await db.apiSpec.create({ data: { workspaceId: workspace.id, apiKey: "synthetic-webhook-payments", environment: "default", name: "Synthetic payments",
    version: "1.0.0", sourceFilename: "synthetic.json", openApiVersion: "3.1.0", sourceText: source, parsedDocument: document, sourceSha256: createHash("sha256").update(source).digest("hex"), isActive: true } });
  async function accept(body: unknown = { amount: "100" }) { return acceptSyntheticWebhook(db, key.token, randomUUID(), sanitizeSyntheticWebhook(body)); }
  return { workspace, spec, key, accept };
}
describe("workspace-scoped webhook receipt review", () => {
  it("shows pending then passed, mismatch, incomplete and failed based on stored results", async () => {
    const f = await fixture();
    const passed = await f.accept({ amount: 100 }); const mismatch = await f.accept();
    const incomplete = await f.accept({ amount: "100", email: `private-${randomUUID()}@example.test` }); const failed = await f.accept();
    expect((await loadWebhookReceipt(db, f.workspace.id, passed.id, { page: 1 }))?.state).toBe("Pending");
    for (const id of [passed.id, mismatch.id, incomplete.id]) await processWebhookValidation(db, f.workspace.id, id);
    await db.outboxEvent.updateMany({ where: { webhookReceiptId: failed.id }, data: { dispatchStatus: "FAILED", lastError: "private diagnostics must not reach the UI" } });
    const list = await listWebhookReceipts(db, f.workspace.id, { page: 1 });
    expect((await loadWebhookReceipt(db, f.workspace.id, failed.id, { page: 1 }))?.groupingLabel).toBe("Not evaluated · validation did not complete");
    expect(list.rows.map((row) => row.state).sort()).toEqual(["Passed", "Mismatch", "Incomplete", "Failed"].sort());
    expect(JSON.stringify(list)).not.toContain(f.key.token); expect(JSON.stringify(list)).not.toContain("private diagnostics");
    const detail = await loadWebhookReceipt(db, f.workspace.id, mismatch.id, { page: 1 });
    expect(detail).toMatchObject({ state: "Mismatch", specId: f.spec.id, payload: '{\n  "amount": "100"\n}', findings: [{ path: "/amount", expected: "integer", received: "string" }] });
    const protectedDetail = await loadWebhookReceipt(db, f.workspace.id, incomplete.id, { page: 1 });
    expect(protectedDetail?.omissions).toEqual(["email"]); expect(protectedDetail?.payload).not.toContain("private-");
    expect(await db.incident.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
  });
  it("does not expose another workspace receipt or a receipt outside environment/service scope", async () => {
    const owner = await fixture(); const other = await fixture(); const receipt = await owner.accept();
    expect((await listWebhookReceipts(db, other.workspace.id, { page: 1 })).total).toBe(0);
    expect(await loadWebhookReceipt(db, other.workspace.id, receipt.id, { page: 1 })).toBeNull();
    expect(await loadWebhookReceipt(db, owner.workspace.id, receipt.id, { page: 1, environment: "staging" })).toBeNull();
    expect(await loadWebhookReceipt(db, owner.workspace.id, receipt.id, { page: 1, service: "other" })).toBeNull();
    expect(await loadWebhookReceipt(db, owner.workspace.id, "not-a-uuid", { page: 1 })).toBeNull();
    expect((await listWebhookReceipts(db, owner.workspace.id, { page: 1, environment: "staging" })).rows).toEqual([]);
  });
  it("paginates in stable receipt order and omits unsupported stored payload formats", async () => {
    const f = await fixture(); for (let index = 0; index < 21; index++) await f.accept({ amount: index });
    const page1 = await listWebhookReceipts(db, f.workspace.id, { page: 1 }); const page2 = await listWebhookReceipts(db, f.workspace.id, { page: 2 });
    expect(page1.rows).toHaveLength(20); expect(page2.rows).toHaveLength(1); expect(page1.pages).toBe(2);
    expect(new Set([...page1.rows, ...page2.rows].map((row) => row.id)).size).toBe(21);
    const malformed = await db.webhookReceipt.create({ data: { workspaceId: f.workspace.id, collectorCredentialId: f.key.credential.id, sourceEventId: randomUUID(),
      apiKey: "synthetic-webhook-payments", environment: "default", operationPath: "/payments", sanitizedPayload: { email: "private-unsupported@example.test" },
      protection: { policy: "unknown" }, revisionSelection: {}, validationStatus: "PASSED" } });
    const detail = await loadWebhookReceipt(db, f.workspace.id, malformed.id, { page: 1 });
    expect(detail?.payload).toBeNull(); expect(detail?.omissions).toBeNull(); expect(JSON.stringify(detail)).not.toContain("private-unsupported");
    expect(detail?.state).toBe("Incomplete"); expect(detail?.selectionLabel).toBe("Selection provenance unavailable");
  });
});
