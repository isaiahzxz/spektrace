import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import { Worker } from "bullmq";
import { Client } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireTestDatabaseUrl } from "@/lib/env";
import { createStripeTestExpressApp } from "@/server/webhooks/stripe-test-express-app";
import { issueIngestionCredential, revokeIngestionCredential } from "@/server/services/ingestion-credentials";
import { routeWorkerJob } from "@/server/services/route-worker-job";
import { dispatchOutboxBatch, reconcileWebhookOutbox } from "@/server/outbox/dispatcher";
import { getIncidentQueue, resetIncidentQueueForTests } from "@/lib/queue/incident-queue";
import { disconnectRedis, getWorkerRedis } from "@/lib/redis";
import { getIncidentQueueName, type IncidentJobPayload } from "@/lib/queue/job-types";
import { type StripeTestEndpointConfig } from "@/server/webhooks/stripe-snapshot-verification";

const url = requireTestDatabaseUrl();
if (new URL(url).pathname.slice(1) !== process.env.SPEKTRACE_HISTORICAL_VERIFY_DATABASE ||
  !/^spektrace_test_history_[a-f0-9]{32}$/.test(process.env.SPEKTRACE_HISTORICAL_VERIFY_DATABASE ?? ""))
  throw new Error("Use the disposable Stripe receipt verification wrapper");
const db = createPrismaClientForUrl(url);
process.env.SPEKTRACE_REDIS_PREFIX = `stripe-receipts-${randomUUID()}`;
afterAll(async () => { await resetIncidentQueueForTests(); await disconnectRedis(); await db.$disconnect(); });
async function fixture() {
  const workspace = await db.workspace.create({ data: { name: "Synthetic Stripe", slug: `stripe-${randomUUID()}` } });
  const key = await issueIngestionCredential(db, workspace.id, "Synthetic Stripe collector");
  const integration = await db.stripeWebhookIntegration.create({ data: { workspaceId: workspace.id, ingestionCredentialId: key.credential.id } });
  const secret = { id: randomUUID(), value: `whsec_${randomUUID().replaceAll("-", "")}`, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
  const config: StripeTestEndpointConfig = { workspaceId: workspace.id, integrationId: integration.id, mode: "test", secrets: [secret] };
  return { workspace, key, integration, config, secret };
}
async function listen(f: Awaited<ReturnType<typeof fixture>>, token = f.key.token) {
  const server = createStripeTestExpressApp(db, f.config, token).listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing address");
  return { server, endpoint: `http://127.0.0.1:${address.port}/stripe/test/webhooks` };
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
function event(id = `evt_${randomUUID().replaceAll("-", "")}`, object: Record<string, unknown> = { amount: "100", currency: "usd", status: "failed" }) {
  return { id, object: "event", type: "payment_intent.payment_failed", created: 1792701900, livemode: false,
    api_version: "2026-09-30.clover", data: { object: { object: "payment_intent", ...object } } };
}
function signature(body: string, secret: string, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}
function post(endpoint: string, f: Awaited<ReturnType<typeof fixture>>, value = event(), overrides: Record<string, string> = {}) {
  const body = JSON.stringify(value);
  return fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": signature(body, f.secret.value), ...overrides }, body });
}

describe("Stripe test receipt acceptance", () => {
  it("atomically acknowledges one receipt/job, deduplicates concurrent retries by original event id and compares retained shape", async () => {
    const f = await fixture(), app = await listen(f), value = event();
    try {
      const responses = await Promise.all([post(app.endpoint, f, value), post(app.endpoint, f, value)]);
      expect(responses.map(r => r.status).sort()).toEqual([200, 202]);
      const bodies = await Promise.all(responses.map(r => r.json())); expect(bodies[0].receiptId).toBe(bodies[1].receiptId);
      expect(bodies[0].meaning).toContain("business processing is not confirmed");
      const row = await db.stripeWebhookReceipt.findUniqueOrThrow({ where: { id: bodies[0].receiptId } });
      expect(row).toMatchObject({ sourceEventId: value.id, validationStatus: "NOT_RUN", collectorCredentialId: f.key.credential.id });
      expect(await db.stripeWebhookReceipt.count({ where: { workspaceId: f.workspace.id } })).toBe(1);
      expect(await db.outboxEvent.findMany({ where: { workspaceId: f.workspace.id } })).toMatchObject([{ stripeWebhookReceiptId: row.id, incidentId: null, eventType: "STRIPE_WEBHOOK_VALIDATION_REQUESTED", dispatchStatus: "PENDING" }]);
      expect((await post(app.endpoint, f, event(value.id, { amount: 100, currency: "usd", status: "failed" }))).status).toBe(409);
      expect((await post(app.endpoint, f, { ...value, api_version: "2025-01-01" })).status).toBe(409);
      // Values are intentionally discarded: equal retained shapes are indistinguishable.
      expect((await post(app.endpoint, f, event(value.id, { amount: "different", currency: "eur", status: "other" }))).status).toBe(200);
      expect(await routeWorkerJob(db, { task: "validate-stripe-webhook", workspaceId: randomUUID(), stripeWebhookReceiptId: row.id })).toMatchObject({ reason: "receipt_not_found" });
      expect(await routeWorkerJob(db, { task: "validate-stripe-webhook", workspaceId: f.workspace.id, stripeWebhookReceiptId: row.id })).toMatchObject({ validationStatus: "UNSUPPORTED" });
      const checked = await db.stripeWebhookReceipt.findUniqueOrThrow({ where: { id: row.id } });
      expect(checked.validationEvidence).toMatchObject({ reasonCode: "STRIPE_CONTRACT_NOT_CONFIGURED", bodyValuesRetained: false, businessProcessingConfirmed: false });
      expect(await routeWorkerJob(db, { task: "validate-stripe-webhook", workspaceId: f.workspace.id, stripeWebhookReceiptId: row.id })).toMatchObject({ reason: "already_completed" });
      expect((await db.stripeWebhookReceipt.findUniqueOrThrow({ where: { id: row.id } })).validatedAt).toEqual(checked.validatedAt);
    } finally { await close(app.server); }
  });

  it("retains no customer values, credentials, arbitrary properties or raw body in receipt/job/evidence/responses", async () => {
    const f = await fixture(), app = await listen(f);
    try {
      const value = event(undefined, { amount: "4242424242424242", currency: "unique-private-email@example.test", status: { password: "private-secret" },
        customer: { name: "Unique Private Person" }, metadata: { authorization: "Bearer private-token" } });
      const response = await post(app.endpoint, f, value); expect(response.status).toBe(202); const body = await response.json();
      await routeWorkerJob(db, { task: "validate-stripe-webhook", workspaceId: f.workspace.id, stripeWebhookReceiptId: body.receiptId });
      const retained = JSON.stringify({ body, row: await db.stripeWebhookReceipt.findUniqueOrThrow({ where: { id: body.receiptId } }),
        jobs: await db.outboxEvent.findMany({ where: { workspaceId: f.workspace.id } }) });
      for (const marker of ["4242424242424242", "unique-private-email", "private-secret", "Unique Private Person", "private-token", f.secret.value, f.key.token]) expect(retained).not.toContain(marker);
      expect(await db.incident.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
      expect(await db.investigationInferenceRun.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    } finally { await close(app.server); }
  });

  it("survives signing/collector rotation without changing namespace or rewriting first provenance", async () => {
    const f = await fixture(), value = event(), app = await listen(f);
    let receiptId: string;
    try { const response = await post(app.endpoint, f, value); expect(response.status).toBe(202); receiptId = (await response.json()).receiptId; }
    finally { await close(app.server); }
    const nextKey = await issueIngestionCredential(db, f.workspace.id, "Rotated synthetic collector");
    await db.stripeWebhookIntegration.update({ where: { id: f.integration.id }, data: { ingestionCredentialId: nextKey.credential.id } });
    const secret = { ...f.secret, id: randomUUID(), value: `whsec_${randomUUID().replaceAll("-", "")}` };
    const rotated = { ...f, key: nextKey, secret, config: { ...f.config, secrets: [secret] } }, nextApp = await listen(rotated);
    try { const response = await post(nextApp.endpoint, rotated, value); expect(response.status).toBe(200); expect((await response.json()).receiptId).toBe(receiptId); }
    finally { await close(nextApp.server); }
    const row = await db.stripeWebhookReceipt.findUniqueOrThrow({ where: { id: receiptId } });
    expect(row.collectorCredentialId).toBe(f.key.credential.id); expect(row.verification).toMatchObject({ signingSecretId: f.secret.id });
  });

  it("enforces workspace, enabled integration, current collector and revocation even on duplicate delivery", async () => {
    const f = await fixture(), other = await fixture(), value = event();
    const wrongApp = await listen(f, other.key.token);
    try { expect((await post(wrongApp.endpoint, f, value)).status).toBe(401); } finally { await close(wrongApp.server); }
    const app = await listen(f);
    try {
      expect((await post(app.endpoint, f, value)).status).toBe(202);
      await db.stripeWebhookIntegration.update({ where: { id: f.integration.id }, data: { disabledAt: new Date() } });
      expect((await post(app.endpoint, f, value)).status).toBe(401);
      await db.stripeWebhookIntegration.update({ where: { id: f.integration.id }, data: { disabledAt: null } });
      await revokeIngestionCredential(db, f.workspace.id, f.key.credential.id);
      expect((await post(app.endpoint, f, value)).status).toBe(401);
      expect(await db.stripeWebhookReceipt.count({ where: { workspaceId: other.workspace.id } })).toBe(0);
      expect(await db.stripeWebhookReceipt.count({ where: { workspaceId: f.workspace.id } })).toBe(1);
    } finally { await close(app.server); }
  });

  it("rejects unsigned, live, Connect, changed, unsupported, compressed, oversized and wrong-path events without writes", async () => {
    const f = await fixture(), app = await listen(f);
    try {
      for (const value of [{ ...event(), livemode: true }, { ...event(), account: "acct_private" }, { ...event(), type: "charge.succeeded" }])
        expect((await post(app.endpoint, f, value)).status).toBe(400);
      expect((await post(app.endpoint, f, event(), { "stripe-signature": "invalid" })).status).toBe(400);
      expect((await post(app.endpoint, f, event(), { "content-encoding": "gzip" })).status).toBe(415);
      expect((await post(app.endpoint, f, event(), { "content-type": "text/plain" })).status).toBe(415);
      expect((await post(`${app.endpoint}?workspace=other`, f)).status).toBe(404);
      expect((await post(app.endpoint, f, event(undefined, { amount: "x".repeat(140_000) }))).status).toBe(413);
      const raw = JSON.stringify(event());
      expect((await fetch(app.endpoint, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": signature(raw, f.secret.value) }, body: raw + " " })).status).toBe(400);
      expect(await db.stripeWebhookReceipt.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    } finally { await close(app.server); }
  });

  it("rolls back the receipt on outbox failure, exposes only a fixed failure and accepts a later retry", async () => {
    const f = await fixture(), app = await listen(f), value = event();
    await db.$executeRawUnsafe(`CREATE FUNCTION fail_stripe_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id = '${f.workspace.id}'::uuid THEN RAISE EXCEPTION 'private-storage-marker'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe("CREATE TRIGGER fail_stripe_outbox BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION fail_stripe_outbox()");
    try {
      const response = await post(app.endpoint, f, value); expect(response.status).toBe(503); expect(await response.text()).not.toContain("private-storage-marker");
      expect(await db.stripeWebhookReceipt.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
      expect(await db.outboxEvent.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    } finally {
      await db.$executeRawUnsafe("DROP TRIGGER fail_stripe_outbox ON outbox_events"); await db.$executeRawUnsafe("DROP FUNCTION fail_stripe_outbox()");
    }
    try { expect((await post(app.endpoint, f, value)).status).toBe(202); } finally { await close(app.server); }
  });

  it("rechecks signature freshness after waiting on the event lock", async () => {
    const f = await fixture(), app = await listen(f), value = event();
    const blocker = new Client({ connectionString: url }); await blocker.connect();
    const lock = JSON.stringify(["stripe-receipt@1", f.workspace.id, f.integration.id, value.id]);
    const pid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await blocker.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [lock]);
    const pending = post(app.endpoint, f, value);
    try {
      const deadline = Date.now() + 2_000; let blocked = false;
      while (Date.now() < deadline) {
        const rows = await blocker.query("SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))", [pid]);
        if (rows.rowCount) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      const later = Date.now() + 301_000; vi.spyOn(Date, "now").mockReturnValue(later);
      await blocker.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lock]);
      expect((await pending).status).toBe(400);
      expect(await db.stripeWebhookReceipt.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
      expect(await db.outboxEvent.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    } finally {
      vi.restoreAllMocks(); await blocker.end(); await pending.catch(() => undefined); await close(app.server);
    }
  });

  it("enforces immutable receipt evidence and cross-workspace database links", async () => {
    const f = await fixture(), other = await fixture(), app = await listen(f);
    try {
      const response = await post(app.endpoint, f); expect(response.status).toBe(202); const { receiptId } = await response.json();
      await expect(db.stripeWebhookReceipt.update({ where: { id: receiptId }, data: { sourceEventId: "evt_changed" } })).rejects.toThrow();
      await expect(db.stripeWebhookIntegration.update({ where: { id: f.integration.id }, data: { workspaceId: other.workspace.id } })).rejects.toThrow();
      await expect(db.outboxEvent.create({ data: { workspaceId: other.workspace.id, dedupeKey: randomUUID(), stripeWebhookReceiptId: receiptId, eventType: "STRIPE_WEBHOOK_VALIDATION_REQUESTED" } })).rejects.toThrow();
      await expect(db.outboxEvent.create({ data: { workspaceId: f.workspace.id, dedupeKey: randomUUID(), stripeWebhookReceiptId: receiptId, eventType: "INCIDENT_VALIDATION_REQUESTED" } })).rejects.toThrow();
    } finally { await close(app.server); }
  });

  it("recovers a lost published job and validates through the real Redis worker queue", async () => {
    const f = await fixture(), app = await listen(f);
    const response = await post(app.endpoint, f); expect(response.status).toBe(202); const { receiptId } = await response.json(); await close(app.server);
    await dispatchOutboxBatch(db, { workspaceId: f.workspace.id });
    const event = await db.outboxEvent.findFirstOrThrow({ where: { stripeWebhookReceiptId: receiptId } });
    const lost = await getIncidentQueue().getJob(event.id); expect(lost?.data).toMatchObject({ task: "validate-stripe-webhook", stripeWebhookReceiptId: receiptId }); await lost?.remove();
    await db.outboxEvent.update({ where: { id: event.id }, data: { publishedAt: new Date(Date.now() - 60_000) } });
    await reconcileWebhookOutbox(db);
    expect(await db.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({ dispatchStatus: "PENDING" });
    const worker = new Worker<IncidentJobPayload>(getIncidentQueueName(), job => routeWorkerJob(db, job.data), { connection: getWorkerRedis() });
    try {
      await worker.waitUntilReady(); const completed = once(worker, "completed");
      await dispatchOutboxBatch(db, { workspaceId: f.workspace.id }); await completed;
      expect((await db.stripeWebhookReceipt.findUniqueOrThrow({ where: { id: receiptId } })).validationStatus).toBe("UNSUPPORTED");
      expect(await db.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({ dispatchStatus: "PUBLISHED" });
    } finally { await worker.close(); await getIncidentQueue().obliterate({ force: true }); }
  }, 20_000);
});
