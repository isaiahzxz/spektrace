import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import { afterAll, expect, it } from "vitest";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireTestDatabaseUrl } from "@/lib/env";
import { issueIngestionCredential } from "@/server/services/ingestion-credentials";
import { importSenderBinding } from "@/server/services/sender-identity";
import { createSignedSyntheticWebhookApp } from "@/server/webhooks/signed-synthetic-express-app";
import type { SyntheticSigningKey } from "@/server/webhooks/synthetic-signature";
import { routeWorkerJob } from "@/server/services/route-worker-job";
import { loadWebhookReceipt } from "@/server/dashboard/webhook-receipts";

const url = requireTestDatabaseUrl();
if (new URL(url).pathname.slice(1) !== process.env.SPEKTRACE_HISTORICAL_VERIFY_DATABASE ||
  !/^spektrace_test_history_[a-f0-9]{32}$/.test(process.env.SPEKTRACE_HISTORICAL_VERIFY_DATABASE ?? ""))
  throw new Error("Use disposable configured revision verification");
const db = createPrismaClientForUrl(url); afterAll(() => db.$disconnect());

async function fixture() {
  const workspace = await db.workspace.create({ data: { name: "Configured synthetic revision", slug: `revision-${randomUUID()}` } });
  const collector = await issueIngestionCredential(db, workspace.id, "Synthetic revision collector");
  async function spec(type: string, active: boolean, scope: { workspaceId?: string; apiKey?: string; environment?: string } = {}) {
    const document = { openapi: "3.1.0", paths: { "/payments": { post: { requestBody: { content: { "application/json": {
      schema: { type: "object", required: ["amount"], properties: { amount: { type } } },
    } } } } } } };
    const source = JSON.stringify(document);
    return db.apiSpec.create({ data: { workspaceId: scope.workspaceId ?? workspace.id, apiKey: scope.apiKey ?? "synthetic-webhook-payments",
      environment: scope.environment ?? "default", name: "Synthetic revision payments", version: type === "integer" ? "1.0.0" : "2.0.0",
      openApiVersion: "3.1.0", sourceFilename: "synthetic.json", sourceText: source, parsedDocument: document,
      sourceSha256: createHash("sha256").update(source).digest("hex"), isActive: active } });
  }
  const old = await spec("integer", false), current = await spec("number", true);
  const key: SyntheticSigningKey = { keyId: randomUUID(), workspaceId: workspace.id, credentialId: collector.credential.id,
    principalRef: randomUUID(), principalKind: "client_id", secretHex: randomBytes(32).toString("hex"),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), revisionBinding: { apiSpecId: old.id, sourceSha256: old.sourceSha256 } };
  await importSenderBinding(db, workspace.id, { ingestionCredentialId: key.credentialId, apiKey: "synthetic-webhook-payments", environment: "default",
    principalRef: key.principalRef, principalKind: key.principalKind, senderKey: randomUUID(), displayName: "Synthetic bound sender" });
  const servers: Server[] = [];
  async function start(config = key) {
    const server = createSignedSyntheticWebhookApp(db, [config]).listen(0, "127.0.0.1"); servers.push(server); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing synthetic listener"); const port = address.port;
    return async (raw = '{"amount":100.5}', event = randomUUID(), extra: Record<string, string> = {}) => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const prefix = `synthetic-hmac-sha256@1\nPOST\n/synthetic/signed-webhooks/payments\n${config.keyId}\n${workspace.id}\n${key.credentialId}\nclient_id\n${key.principalRef}\n${event}\n${timestamp}\n`;
      const signature = createHmac("sha256", Buffer.from(config.secretHex, "hex")).update(prefix).update(raw).digest("hex");
      const response = await fetch(`http://127.0.0.1:${port}/synthetic/signed-webhooks/payments`, { method: "POST", body: raw,
        headers: { authorization: `Bearer ${collector.token}`, "content-type": "application/json", "x-spek-key-id": config.keyId,
          "x-spek-event-id": event, "x-spek-timestamp": timestamp, "x-spek-signature": `v1=${signature}`, ...extra } });
      return { status: response.status, body: await response.json() as { receiptId?: string; error?: string } };
    };
  }
  async function checked(result: { status: number; body: { receiptId?: string } }) {
    expect(result.status).toBe(202); const id = result.body.receiptId; if (!id) throw new Error("Expected accepted receipt");
    await routeWorkerJob(db, { task: "validate-webhook", workspaceId: workspace.id, webhookReceiptId: id });
    return db.webhookReceipt.findUniqueOrThrow({ where: { id } });
  }
  async function close() { for (const server of servers) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } }
  return { workspace, old, current, key, spec, start, checked, close };
}

it("uses the configured inactive revision instead of the active schema and renders honest provenance", async () => {
  const f = await fixture();
  try {
    const send = await f.start();
    const stored = await f.checked(await send());
    expect(stored.apiSpecId).toBe(f.old.id); expect(stored.validationStatus).toBe("MISMATCH");
    expect(stored.revisionSelection).toMatchObject({ version: "configured-at-acceptance@1", runtimeVerified: false, sourceSha256: f.old.sourceSha256 });
    const view = await loadWebhookReceipt(db, f.workspace.id, stored.id, { page: 1 });
    expect(view?.selectionLabel).toBe("Server-configured revision · runtime unverified");
    expect(view?.state).toBe("Mismatch"); expect(view?.driftGroup?.count).toBe(1);
    const unbound = await f.start({ ...f.key, revisionBinding: undefined });
    const active = await f.checked(await unbound('{"amount":100.5}', randomUUID(), { "x-spek-spec-id": f.old.id, "x-api-spec-id": f.old.id }));
    expect(active.apiSpecId).toBe(f.current.id); expect(active.validationStatus).toBe("PASSED");
    expect((await loadWebhookReceipt(db, f.workspace.id, active.id, { page: 1 }))?.selectionLabel).toBe("Active at acceptance · runtime unverified");
    expect((await db.apiSpec.findUniqueOrThrow({ where: { id: f.old.id } })).isActive).toBe(false);
    expect((await db.apiSpec.findUniqueOrThrow({ where: { id: f.current.id } })).isActive).toBe(true);
    expect(await db.incident.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    expect(await db.investigationInferenceRun.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
  } finally { await f.close(); }
});

it("keeps the same sender's different revisions in separate groups", async () => {
  const f = await fixture();
  try {
    const historical = await f.start(); const active = await f.start({ ...f.key, revisionBinding: undefined });
    const a = await f.checked(await historical('{"amount":"100"}')), b = await f.checked(await active('{"amount":"100"}'));
    const da = await db.webhookGroupingDecision.findUniqueOrThrow({ where: { receiptId: a.id } });
    const dbb = await db.webhookGroupingDecision.findUniqueOrThrow({ where: { receiptId: b.id } });
    expect(da.reason).toBe("GROUPED"); expect(dbb.reason).toBe("GROUPED"); expect(da.groupId).not.toBe(dbb.groupId);
    expect((await db.webhookDriftGroup.findUniqueOrThrow({ where: { id: da.groupId! } })).apiSpecId).toBe(f.old.id);
    expect((await db.webhookDriftGroup.findUniqueOrThrow({ where: { id: dbb.groupId! } })).apiSpecId).toBe(f.current.id);
  } finally { await f.close(); }
});

it("rejects missing, wrong-scope and wrong-hash configured targets without any active fallback or writes", async () => {
  const f = await fixture();
  try {
    const other = await db.workspace.create({ data: { name: "Foreign revision", slug: `foreign-${randomUUID()}` } });
    const foreign = await f.spec("integer", false, { workspaceId: other.id });
    const service = await f.spec("integer", false, { apiKey: "other-service" });
    const environment = await f.spec("integer", false, { environment: "staging" });
    for (const target of [foreign, service, environment, { id: randomUUID(), sourceSha256: f.old.sourceSha256 }, { id: f.old.id, sourceSha256: "0".repeat(64) }]) {
      const send = await f.start({ ...f.key, revisionBinding: { apiSpecId: target.id, sourceSha256: target.sourceSha256 } });
      const result = await send(); expect(result.status, "configured target isolation").toBe(422);
      expect(result.body).toEqual({ error: "Configured revision unavailable; acceptance not confirmed" });
    }
    expect(await db.webhookReceipt.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
    expect(await db.outboxEvent.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
  } finally { await f.close(); }
});

it("deduplicates configured retries and conflicts rather than relabeling when the configuration changes", async () => {
  const f = await fixture();
  try {
    const send = await f.start(); const event = randomUUID(); const first = await f.checked(await send('{"amount":100.5}', event));
    expect((await send('{"amount":100.5}', event))).toMatchObject({ status: 200, body: { receiptId: first.id } });
    const changed = await f.start({ ...f.key, revisionBinding: { apiSpecId: f.current.id, sourceSha256: f.current.sourceSha256 } });
    const unbound = await f.start({ ...f.key, revisionBinding: undefined });
    expect((await changed('{"amount":100.5}', event)).status).toBe(409);
    expect((await unbound('{"amount":100.5}', event)).status).toBe(409);
    const activeEvent = randomUUID(); const active = await f.checked(await unbound('{"amount":100.5}', activeEvent));
    expect((await send('{"amount":100.5}', activeEvent)).status).toBe(409);
    expect(await db.webhookReceipt.count({ where: { workspaceId: f.workspace.id } })).toBe(2);
    expect(await db.outboxEvent.count({ where: { workspaceId: f.workspace.id } })).toBe(2);
    expect(await db.webhookGroupingDecision.count({ where: { workspaceId: f.workspace.id } })).toBe(2);
    expect((await db.webhookReceipt.findUniqueOrThrow({ where: { id: first.id } })).apiSpecId).toBe(f.old.id);
    expect((await db.webhookReceipt.findUniqueOrThrow({ where: { id: active.id } })).apiSpecId).toBe(f.current.id);
  } finally { await f.close(); }
});

it("copies server configuration at startup and rejects malformed binding configuration", async () => {
  const f = await fixture();
  try {
    const send = await f.start();
    f.key.revisionBinding = { apiSpecId: f.current.id, sourceSha256: f.current.sourceSha256 };
    expect((await f.checked(await send())).apiSpecId).toBe(f.old.id);
    for (const revisionBinding of [{ apiSpecId: "bad", sourceSha256: "0".repeat(64) }, { apiSpecId: f.old.id, sourceSha256: "invalid" }])
      expect(() => createSignedSyntheticWebhookApp(db, [{ ...f.key, revisionBinding }])).toThrow("configuration");
  } finally { await f.close(); }
});
