import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { Server } from "node:http";
import { once } from "node:events";
import { Worker } from "bullmq";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireTestDatabaseUrl } from "@/lib/env";
import { createSyntheticWebhookApp } from "@/server/webhooks/synthetic-express-app";
import { issueIngestionCredential, revokeIngestionCredential } from "@/server/services/ingestion-credentials";
import { processWebhookValidation } from "@/server/services/process-webhook-validation";
import { routeWorkerJob } from "@/server/services/route-worker-job";
import { dispatchOutboxBatch, reconcileWebhookOutbox } from "@/server/outbox/dispatcher";
import { getIncidentQueue, resetIncidentQueueForTests } from "@/lib/queue/incident-queue";
import { disconnectRedis, getWorkerRedis } from "@/lib/redis";
import { getIncidentQueueName, type IncidentJobPayload } from "@/lib/queue/job-types";
import { generateIngestionToken, ingestionTokenHash } from "@/lib/ingestion/credential-token";

const url = requireTestDatabaseUrl();
if (new URL(url).pathname.slice(1) !== process.env.SPEKTRACE_HISTORICAL_VERIFY_DATABASE ||
  !/^spektrace_test_history_[a-f0-9]{32}$/.test(process.env.SPEKTRACE_HISTORICAL_VERIFY_DATABASE ?? ""))
  throw new Error("Use disposable verify:synthetic-webhook");
const db = createPrismaClientForUrl(url);
process.env.SPEKTRACE_REDIS_PREFIX = `synthetic-webhook-${randomUUID()}`;
afterAll(async () => { await resetIncidentQueueForTests(); await disconnectRedis(); await db.$disconnect(); });

async function fixture() {
  const workspace = await db.workspace.create({ data: { name: "Synthetic webhook", slug: `webhook-${randomUUID()}` } });
  const key = await issueIngestionCredential(db, workspace.id, "Synthetic collector");
  const document = { openapi: "3.1.0", paths: { "/payments": { post: { requestBody: { content: { "application/json": {
    schema: { type: "object", required: ["amount"], properties: { amount: { type: "integer" } }, additionalProperties: false },
  } } } } } } };
  const text = JSON.stringify(document);
  const spec = await db.apiSpec.create({ data: { workspaceId: workspace.id, apiKey: "synthetic-webhook-payments", environment: "default", name: "Synthetic payments",
    version: "1.0.0", openApiVersion: "3.1.0", sourceFilename: "synthetic.json", sourceText: text, parsedDocument: document,
    sourceSha256: createHash("sha256").update(text).digest("hex"), isActive: true } });
  return { workspace, key, spec };
}
async function listen(client = db) {
  const server = createSyntheticWebhookApp(client).listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing local address");
  return { server, endpoint: `http://127.0.0.1:${address.port}/synthetic/webhooks/payments` };
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
async function post(endpoint: string, token: string, eventId = randomUUID(), body: unknown = { amount: "100" }) {
  return fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-spek-event-id": eventId }, body: JSON.stringify(body) });
}

describe("durable synthetic webhook acceptance", () => {
  it("commits one receipt and outbox before acknowledging, deduplicates concurrent retries and conflicts on changed retained payload", async () => {
    const f = await fixture(); const app = await listen(); const event = randomUUID();
    try {
      const responses = await Promise.all([post(app.endpoint, f.key.token, event), post(app.endpoint, f.key.token, event)]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 202]);
      const bodies = await Promise.all(responses.map((response) => response.json())); expect(bodies[0].receiptId).toBe(bodies[1].receiptId);
      expect(bodies[0].meaning).toContain("no business processing");
      expect(await db.webhookReceipt.count({ where: { workspaceId: f.workspace.id } })).toBe(1);
      const outbox = await db.outboxEvent.findMany({ where: { workspaceId: f.workspace.id } });
      expect(outbox).toHaveLength(1); expect(outbox[0]).toMatchObject({ eventType: "WEBHOOK_VALIDATION_REQUESTED", webhookReceiptId: bodies[0].receiptId, dispatchStatus: "PENDING", incidentId: null });
      expect((await post(app.endpoint, f.key.token, event, { amount: 100 })).status).toBe(409);
      await revokeIngestionCredential(db, f.workspace.id, f.key.credential.id);
      expect((await post(app.endpoint, f.key.token, event)).status).toBe(401);
    } finally { await close(app.server); }
  });

  it("omits named PII before persistence, labels incomplete checks, and dedupes only the sanitized projection", async () => {
    const f = await fixture(); const app = await listen(); const event = randomUUID();
    try {
      const response = await post(app.endpoint, f.key.token, event, { amount: "100", email: "forbidden-unique@example.test", name: "Private Name", password: "never-store-this" });
      expect(response.status).toBe(202); const { receiptId } = await response.json();
      const row = await db.webhookReceipt.findUniqueOrThrow({ where: { id: receiptId } });
      expect(row.sanitizedPayload).toEqual({ amount: "100" });
      expect(JSON.stringify(row)).not.toContain("forbidden-unique"); expect(JSON.stringify(row)).not.toContain("never-store-this");
      expect((await post(app.endpoint, f.key.token, event, { amount: "100", email: "different@example.test", name: "Different", password: "different" })).status).toBe(200);
      expect(await routeWorkerJob(db, { workspaceId: f.workspace.id, webhookReceiptId: receiptId, task: "validate-webhook" })).toMatchObject({ validationStatus: "UNSUPPORTED" });
      expect((await db.webhookReceipt.findUniqueOrThrow({ where: { id: receiptId } })).validationEvidence).toMatchObject({ reasonCode: "WEBHOOK_PAYLOAD_INCOMPLETE" });
    } finally { await close(app.server); }
  });

  it("rejects unauthorized, expired, malformed, oversized, non-JSON and unallowlisted requests with fixed errors", async () => {
    const f = await fixture(); const app = await listen(); const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await post(app.endpoint, "wrong")).status).toBe(401);
      for (const body of [{ secret: "never-store" }, { amount: "person@example.test" }, { amount: "4242424242424242" }])
        expect((await post(app.endpoint, f.key.token, randomUUID(), body)).status).toBe(400);
      const malformed = await fetch(app.endpoint, { method: "POST", headers: { authorization: `Bearer ${f.key.token}`, "content-type": "application/json" }, body: '{"password":"unique-secret",broken' });
      expect(malformed.status).toBe(400); expect(await malformed.text()).not.toContain("unique-secret");
      const oversized = await post(app.endpoint, f.key.token, randomUUID(), { name: "private".repeat(1000) }); expect(oversized.status).toBe(413);
      const text = await fetch(app.endpoint, { method: "POST", headers: { authorization: `Bearer ${f.key.token}`, "content-type": "text/plain" }, body: "private" }); expect(text.status).toBe(415);
      const expired = generateIngestionToken();
      await db.ingestionCredential.create({ data: { id: expired.id, workspaceId: f.workspace.id, name: "Expired fixture", tokenSha256: ingestionTokenHash(expired.token),
        createdAt: new Date("2019-01-01T00:00:00Z"), expiresAt: new Date("2020-01-01T00:00:00Z") } });
      expect((await post(app.endpoint, expired.token)).status).toBe(401);
      expect(await db.webhookReceipt.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
      expect(errorLog).not.toHaveBeenCalled();
    } finally { errorLog.mockRestore(); await close(app.server); }
  });

  it("rolls back receipt on outbox failure and returns 503 instead of false acceptance", async () => {
    const f = await fixture(); const app = await listen(); const event = randomUUID();
    await db.$executeRawUnsafe(`CREATE FUNCTION fail_synthetic_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id = '${f.workspace.id}'::uuid THEN RAISE EXCEPTION 'synthetic failure private-marker'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe("CREATE TRIGGER fail_synthetic_outbox BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION fail_synthetic_outbox()");
    try {
      const response = await post(app.endpoint, f.key.token, event); expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("private-marker");
      expect(await db.webhookReceipt.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
      expect(await db.outboxEvent.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    } finally {
      await db.$executeRawUnsafe("DROP TRIGGER fail_synthetic_outbox ON outbox_events");
      await db.$executeRawUnsafe("DROP FUNCTION fail_synthetic_outbox()"); await close(app.server);
    }
    const retryApp = await listen();
    try { expect((await post(retryApp.endpoint, f.key.token, event)).status).toBe(202); } finally { await close(retryApp.server); }
  });

  it("uses the acceptance pin after activation changes; missing pins stay unsupported; processing is idempotent and workspace scoped", async () => {
    const f = await fixture(); const app = await listen();
    try {
      const response = await post(app.endpoint, f.key.token); const { receiptId } = await response.json();
      await db.apiSpec.update({ where: { id: f.spec.id }, data: { isActive: false } });
      const text = JSON.stringify({ openapi: "3.1.0", paths: {} });
      await db.apiSpec.create({ data: { workspaceId: f.workspace.id, apiKey: "synthetic-webhook-payments", environment: "default", name: "New revision", version: "2.0.0", openApiVersion: "3.1.0", sourceFilename: "new.json", sourceText: text, parsedDocument: JSON.parse(text), sourceSha256: createHash("sha256").update(text).digest("hex"), isActive: true } });
      expect(await processWebhookValidation(db, randomUUID(), receiptId)).toMatchObject({ reason: "receipt_not_found" });
      expect(await processWebhookValidation(db, f.workspace.id, receiptId)).toMatchObject({ validationStatus: "MISMATCH" });
      const checked = await db.webhookReceipt.findUniqueOrThrow({ where: { id: receiptId } });
      expect(checked.validationEvidence).toMatchObject({ specRevision: { apiSpecId: f.spec.id }, findings: [{ jsonPointer: "/amount", expected: "integer" }] });
      expect(await processWebhookValidation(db, f.workspace.id, receiptId)).toMatchObject({ reason: "already_completed" });
      expect((await db.webhookReceipt.findUniqueOrThrow({ where: { id: receiptId } })).validatedAt).toEqual(checked.validatedAt);
      await db.apiSpec.updateMany({ where: { workspaceId: f.workspace.id }, data: { isActive: false } });
      const noPin = await post(app.endpoint, f.key.token); const noPinId = (await noPin.json()).receiptId;
      await db.apiSpec.update({ where: { id: f.spec.id }, data: { isActive: true } });
      expect(await processWebhookValidation(db, f.workspace.id, noPinId)).toMatchObject({ validationStatus: "UNSUPPORTED" });
      await expect(db.webhookReceipt.update({ where: { id: receiptId }, data: { sanitizedPayload: { amount: 100 } } })).rejects.toThrow();
    } finally { await close(app.server); }
  });

  it("stores passing, missing and null body-field outcomes without creating failure incidents or inference", async () => {
    const f = await fixture(); const app = await listen();
    try {
      for (const [body, expected] of [[{ amount: 100 }, "PASSED"], [{}, "MISMATCH"], [{ amount: null }, "MISMATCH"]] as const) {
        const response = await post(app.endpoint, f.key.token, randomUUID(), body); expect(response.status).toBe(202);
        expect(await processWebhookValidation(db, f.workspace.id, (await response.json()).receiptId)).toMatchObject({ validationStatus: expected });
      }
      expect(await db.incident.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
      expect(await db.investigationGroup.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
      expect(await db.investigationInferenceRun.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    } finally { await close(app.server); }
  });

  it("preserves queued acceptance through process restart and delivers a real BullMQ validation job", async () => {
    const f = await fixture(); const beforeRestart = createPrismaClientForUrl(url); const app = await listen(beforeRestart);
    const response = await post(app.endpoint, f.key.token); expect(response.status).toBe(202); const { receiptId } = await response.json();
    await close(app.server); await beforeRestart.$disconnect();
    // Keep unrelated earlier fixtures out of this worker's pending dispatch batch.
    await db.outboxEvent.updateMany({ where: { webhookReceiptId: { not: receiptId }, eventType: "WEBHOOK_VALIDATION_REQUESTED" }, data: { dispatchStatus: "PUBLISHED" } });
    expect((await db.webhookReceipt.findUniqueOrThrow({ where: { id: receiptId } })).validationStatus).toBe("NOT_RUN");
    await dispatchOutboxBatch(db, { workspaceId: f.workspace.id });
    const published = await db.outboxEvent.findFirstOrThrow({ where: { webhookReceiptId: receiptId } });
    const lostJob = await getIncidentQueue().getJob(published.id); expect(lostJob).toBeDefined(); await lostJob?.remove();
    await db.outboxEvent.update({ where: { id: published.id }, data: { publishedAt: new Date(Date.now() - 60_000) } });
    expect(await reconcileWebhookOutbox(db)).toBeGreaterThanOrEqual(1);
    expect(await db.outboxEvent.findUniqueOrThrow({ where: { id: published.id } })).toMatchObject({ dispatchStatus: "PENDING", lastError: "WEBHOOK_JOB_MISSING_REQUEUED" });
    await dispatchOutboxBatch(db, { workspaceId: f.workspace.id });
    const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "src/workers/index.ts"], {
      cwd: process.cwd(), windowsHide: true, stdio: "pipe", env: { ...process.env, DATABASE_URL: url,
        SPEKTRACE_AI_INVESTIGATION_ENABLED: "false", SPEKTRACE_PAYLOAD_PROPOSALS_ENABLED: "false" },
    });
    let logs = ""; child.stdout?.on("data", (chunk) => { logs += chunk.toString(); }); child.stderr?.on("data", (chunk) => { logs += chunk.toString(); });
    try {
      const deadline = Date.now() + 20_000;
      let row = await db.webhookReceipt.findUniqueOrThrow({ where: { id: receiptId } });
      while (row.validationStatus === "NOT_RUN" && Date.now() < deadline) { await new Promise((resolve) => setTimeout(resolve, 150)); row = await db.webhookReceipt.findUniqueOrThrow({ where: { id: receiptId } }); }
      expect(row.validationStatus).toBe("MISMATCH"); expect(logs).toContain("outbox dispatcher running");
      expect(await db.outboxEvent.findFirst({ where: { webhookReceiptId: receiptId } })).toMatchObject({ dispatchStatus: "PUBLISHED" });
      const queue = getIncidentQueue(); const job = await queue.getJob((await db.outboxEvent.findFirstOrThrow({ where: { webhookReceiptId: receiptId } })).id);
      expect(job?.data).toMatchObject({ task: "validate-webhook", webhookReceiptId: receiptId, workspaceId: f.workspace.id });
      expect(logs).not.toContain(f.key.token);
    } finally {
      if (child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
      await getIncidentQueue().obliterate({ force: true });
    }
  }, 30_000);

  it("returns pending work after a queue publish failure for later dispatch", async () => {
    const f = await fixture(); const app = await listen();
    try { expect((await post(app.endpoint, f.key.token)).status).toBe(202); } finally { await close(app.server); }
    await dispatchOutboxBatch(db, { workspaceId: f.workspace.id, batchSize: 20, publishJob: async () => { throw new Error("Synthetic queue unavailable"); } });
    expect(await db.outboxEvent.findFirst({ where: { workspaceId: f.workspace.id } })).toMatchObject({ dispatchStatus: "PENDING" });
    expect((await db.webhookReceipt.findFirstOrThrow({ where: { workspaceId: f.workspace.id } })).validationStatus).toBe("NOT_RUN");
  });

  it("does not acknowledge acceptance when the database is unavailable", async () => {
    const f = await fixture();
    const missing = new URL(url); missing.pathname = `/spektrace_test_missing_${randomUUID().replaceAll("-", "")}`;
    const unavailable = createPrismaClientForUrl(missing.toString()); const app = await listen(unavailable);
    try {
      const response = await post(app.endpoint, f.key.token); expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "Storage unavailable" });
      expect(await db.webhookReceipt.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    } finally { await close(app.server); await unavailable.$disconnect(); }
  });

  it("records exhausted validation jobs for operator review instead of endlessly requeueing", async () => {
    const f = await fixture(); const app = await listen();
    let receiptId: string;
    try { const response = await post(app.endpoint, f.key.token); expect(response.status).toBe(202); receiptId = (await response.json()).receiptId; }
    finally { await close(app.server); }
    const event = await db.outboxEvent.findFirstOrThrow({ where: { webhookReceiptId: receiptId } });
    await db.$executeRawUnsafe(`CREATE FUNCTION fail_webhook_validation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${receiptId}'::uuid THEN RAISE EXCEPTION 'Synthetic storage failure'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe("CREATE TRIGGER fail_webhook_validation BEFORE UPDATE ON webhook_receipts FOR EACH ROW EXECUTE FUNCTION fail_webhook_validation()");
    const worker = new Worker<IncidentJobPayload>(getIncidentQueueName(), (job) => routeWorkerJob(db, job.data), { connection: getWorkerRedis() });
    try {
      await worker.waitUntilReady();
      const failed = once(worker, "failed");
      await getIncidentQueue().add("validate-webhook", { workspaceId: f.workspace.id, webhookReceiptId: receiptId, task: "validate-webhook" }, { jobId: event.id, attempts: 1 });
      await failed;
      await db.outboxEvent.update({ where: { id: event.id }, data: { dispatchStatus: "PUBLISHED", publishedAt: new Date(Date.now() - 60_000) } });
      expect((await db.webhookReceipt.findUniqueOrThrow({ where: { id: receiptId } })).validationStatus).toBe("NOT_RUN");
      await reconcileWebhookOutbox(db);
      expect(await db.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({ dispatchStatus: "FAILED", lastError: "WEBHOOK_JOB_TERMINAL_WITHOUT_VALIDATION" });
      expect(await reconcileWebhookOutbox(db)).toBe(0);
    } finally {
      await worker.close();
      await db.$executeRawUnsafe("DROP TRIGGER fail_webhook_validation ON webhook_receipts");
      await db.$executeRawUnsafe("DROP FUNCTION fail_webhook_validation()");
      await getIncidentQueue().obliterate({ force: true });
    }
  }, 20_000);
});
