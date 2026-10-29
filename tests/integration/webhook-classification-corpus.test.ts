import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireTestDatabaseUrl } from "@/lib/env";
import { issueIngestionCredential } from "@/server/services/ingestion-credentials";
import { importSenderBinding } from "@/server/services/sender-identity";
import { createSignedSyntheticWebhookApp } from "@/server/webhooks/signed-synthetic-express-app";
import type { SyntheticSigningKey } from "@/server/webhooks/synthetic-signature";
import { routeWorkerJob } from "@/server/services/route-worker-job";
import { listWebhookGroups, loadWebhookGroup } from "@/server/dashboard/webhook-groups";

const url = requireTestDatabaseUrl();
if (new URL(url).pathname.slice(1) !== process.env.SPEKTRACE_HISTORICAL_VERIFY_DATABASE ||
  !/^spektrace_test_history_[a-f0-9]{32}$/.test(process.env.SPEKTRACE_HISTORICAL_VERIFY_DATABASE ?? ""))
  throw new Error("Use disposable classification verification");
const db = createPrismaClientForUrl(url);
afterAll(() => db.$disconnect());

it("classifies the bounded signed HTTP corpus against independent revision, sender, drift and retry expectations", async () => {
  const workspace = await db.workspace.create({ data: { name: "Synthetic classification corpus", slug: `corpus-${randomUUID()}` } });
  const credential = await issueIngestionCredential(db, workspace.id, "Synthetic corpus collector");
  async function revision(version: string, type: string, minimum?: number) {
    const document = { openapi: "3.1.0", info: { title: "Synthetic corpus payments", version }, paths: { "/payments": { post: {
      requestBody: { content: { "application/json": { schema: { type: "object", required: ["amount"],
        properties: { amount: { type, ...(minimum === undefined ? {} : { minimum }) } } } } } },
    } } } };
    const source = JSON.stringify(document);
    return db.apiSpec.create({ data: { workspaceId: workspace.id, apiKey: "synthetic-webhook-payments", environment: "default",
      name: "Synthetic corpus payments", version, openApiVersion: "3.1.0", sourceFilename: "synthetic-corpus.json",
      sourceText: source, parsedDocument: document, sourceSha256: createHash("sha256").update(source).digest("hex"), isActive: true } });
  }
  async function sender(label: string) {
    const key: SyntheticSigningKey = { keyId: randomUUID(), workspaceId: workspace.id, credentialId: credential.credential.id,
      principalKind: "client_id", principalRef: randomUUID(), secretHex: randomBytes(32).toString("hex"),
      expiresAt: new Date(Date.now() + 3600_000).toISOString() };
    const binding = await importSenderBinding(db, workspace.id, { ingestionCredentialId: key.credentialId,
      apiKey: "synthetic-webhook-payments", environment: "default", principalKind: key.principalKind,
      principalRef: key.principalRef, senderKey: randomUUID(), displayName: label });
    return { key, senderId: binding.binding.senderId };
  }
  const a = await sender("Synthetic sender A"), b = await sender("Synthetic sender B");
  const old = await revision("1.0.0", "integer");
  const server = createSignedSyntheticWebhookApp(db, [a.key, b.key]).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing corpus listener");
  const port = address.port;
  const rows: { name: string; expected: unknown; actual: unknown }[] = [];
  const accepted: string[] = [];
  async function send(raw: string, key = a.key, event = randomUUID(), overrides: Record<string, string> = {}) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    // Independent wire construction; no verifier helper creates the test signatures.
    const prefix = `synthetic-hmac-sha256@1\nPOST\n/synthetic/signed-webhooks/payments\n${key.keyId}\n${workspace.id}\n${key.credentialId}\n${key.principalKind}\n${key.principalRef}\n${event}\n${timestamp}\n`;
    const signature = createHmac("sha256", Buffer.from(key.secretHex, "hex")).update(prefix).update(raw).digest("hex");
    const response = await fetch(`http://127.0.0.1:${port}/synthetic/signed-webhooks/payments`, { method: "POST", body: raw,
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json", "x-spek-event-id": event,
        "x-spek-key-id": key.keyId, "x-spek-timestamp": timestamp, "x-spek-signature": `v1=${signature}`, ...overrides } });
    return { status: response.status, body: await response.json() as { receiptId?: string } };
  }
  async function check(name: string, result: Awaited<ReturnType<typeof send>>, specId: string | null,
    senderId: string, status: string, reason: string) {
    expect(result.status, name).toBe(202); expect(result.body.receiptId, name).toBeTruthy();
    const id = result.body.receiptId!; accepted.push(id);
    await routeWorkerJob(db, { task: "validate-webhook", workspaceId: workspace.id, webhookReceiptId: id });
    const stored = await db.webhookReceipt.findUniqueOrThrow({ where: { id } });
    const decision = await db.webhookGroupingDecision.findUniqueOrThrow({ where: { receiptId: id } });
    const proof = stored.senderVerification as { senderId?: string } | null;
    const expected = { apiSpecId: specId, senderId, validation: status, grouping: reason };
    const actual = { apiSpecId: stored.apiSpecId, senderId: proof?.senderId, validation: stored.validationStatus, grouping: decision.reason };
    rows.push({ name, expected, actual }); expect(actual, name).toEqual(expected);
    return { id, group: decision.groupId, stored };
  }
  async function reject(name: string, raw: string, status: number, overrides: Record<string, string> = {}) {
    const before = await db.webhookReceipt.count({ where: { workspaceId: workspace.id } });
    const result = await send(raw, a.key, randomUUID(), overrides);
    const after = await db.webhookReceipt.count({ where: { workspaceId: workspace.id } });
    const expected = { http: status, newReceipts: 0 }, actual = { http: result.status, newReceipts: after - before };
    rows.push({ name, expected, actual }); expect(actual, name).toEqual(expected);
  }
  try {
    const oldEvent = randomUUID();
    const delayed = await send('{"amount":100.5}', a.key, oldEvent);
    await db.apiSpec.update({ where: { id: old.id }, data: { isActive: false } });
    const current = await revision("2.0.0", "number");
    const first = await check("Accepted under v1, validated after v2 activation", delayed, old.id, a.senderId, "MISMATCH", "GROUPED");
    const equivalent = await check("Same sender and drift, different value", await send('{"amount":"200"}'), current.id, a.senderId, "MISMATCH", "GROUPED");
    expect(first.group).not.toBe(equivalent.group);
    const same = await check("Equivalent v2 drift merges", await send('{"amount":"300"}'), current.id, a.senderId, "MISMATCH", "GROUPED");
    expect(same.group).toBe(equivalent.group);
    const other = await check("Different signed sender stays separate", await send('{"amount":"200"}', b.key), current.id, b.senderId, "MISMATCH", "GROUPED");
    expect(other.group).not.toBe(equivalent.group);
    const spoof = await check("Spoofed sender headers do not override signing identity", await send('{"amount":"400"}', a.key, randomUUID(),
      { "x-client-id": b.key.principalRef, "x-api-key": "synthetic-forged-key" }), current.id, a.senderId, "MISMATCH", "GROUPED");
    expect(spoof.group).toBe(equivalent.group);
    const missing = await check("Missing required amount", await send('{}'), current.id, a.senderId, "MISMATCH", "GROUPED");
    const nil = await check("Null type drift", await send('{"amount":null}'), current.id, a.senderId, "MISMATCH", "GROUPED");
    expect(new Set([missing.group, nil.group, equivalent.group]).size).toBe(3);
    await check("Passing number body check", await send('{"amount":100.5}'), current.id, a.senderId, "PASSED", "NOT_A_MISMATCH");
    const marker = `private-${randomUUID()}@example.test`;
    const incomplete = await check("Redacted body remains incomplete", await send(JSON.stringify({ amount: "100", email: marker })),
      current.id, a.senderId, "UNSUPPORTED", "NOT_A_MISMATCH");
    expect(JSON.stringify(incomplete.stored)).not.toContain(marker);
    const counts = async () => Promise.all([db.webhookReceipt.count({ where: { workspaceId: workspace.id } }),
      db.webhookGroupingDecision.count({ where: { workspaceId: workspace.id } }), db.outboxEvent.count({ where: { workspaceId: workspace.id } })]);
    const beforeRetry = await counts();
    const retry = await send('{"amount":100.5}', a.key, oldEvent);
    expect(retry.status).toBe(200); expect(retry.body.receiptId).toBe(first.id);
    await routeWorkerJob(db, { task: "validate-webhook", workspaceId: workspace.id, webhookReceiptId: first.id });
    expect(await counts()).toEqual(beforeRetry);
    expect((await db.webhookReceipt.findUniqueOrThrow({ where: { id: first.id } })).apiSpecId).toBe(old.id);
    rows.push({ name: "Retry after activation retains original receipt and revision", expected: { http: 200, countsUnchanged: true }, actual: { http: retry.status, countsUnchanged: true } });
    const conflict = await send('{"amount":"999"}', a.key, oldEvent);
    expect(conflict.status).toBe(409); expect(await counts()).toEqual(beforeRetry);
    rows.push({ name: "Changed payload reusing an event id conflicts", expected: 409, actual: conflict.status });
    await reject("Malformed JSON", '{"amount":', 400);
    await reject("Empty request body", '', 401);
    await reject("Array body", '[]', 400);
    await reject("Wrong amount structure", '{"amount":{}}', 400);
    await reject("Unallowlisted extra field", '{"amount":100,"extra":1}', 400);
    await reject("Oversized body", 'x'.repeat(4097), 413);
    await reject("Forged signature", '{"amount":100}', 401, { "x-spek-signature": `v1=${"0".repeat(64)}` });
    await reject("Invalid collector credential", '{"amount":100}', 401, { authorization: "Bearer synthetic-invalid" });
    await db.apiSpec.update({ where: { id: current.id }, data: { isActive: false } });
    const noPin = await send('{"amount":"100"}');
    const unsupported = await revision("3.0.0", "integer", 500);
    await check("No active revision at acceptance never falls forward", noPin, null, a.senderId, "UNSUPPORTED", "NOT_A_MISMATCH");
    await check("Unsupported grouping rule remains an ungrouped mismatch", await send('{"amount":100}'), unsupported.id, a.senderId, "MISMATCH", "EVIDENCE_UNSUPPORTED");
    const groups = await db.webhookDriftGroup.findMany({ where: { workspaceId: workspace.id } });
    expect(groups).toHaveLength(5);
    expect(await db.webhookGroupingDecision.count({ where: { workspaceId: workspace.id, reason: "GROUPED" } })).toBe(7);
    const feed = await listWebhookGroups(db, workspace.id, { page: 1 });
    expect(JSON.stringify(feed)).not.toContain(marker);
    const detail = await loadWebhookGroup(db, workspace.id, equivalent.group!, { page: 1 }, 1);
    expect(detail?.group.count).toBe(3);
    expect(detail?.receipts.map((receipt) => receipt.id).sort()).toEqual([equivalent.id, same.id, spoof.id].sort());
    expect(JSON.stringify(detail)).not.toContain(marker);
    expect(await db.incident.count({ where: { workspaceId: workspace.id } })).toBe(0);
    expect(await db.investigationInferenceRun.count({ where: { workspaceId: workspace.id } })).toBe(0);
    const reportDir = process.env.SPEKTRACE_CLASSIFICATION_REPORT_DIR;
    if (reportDir) {
      const target = path.resolve(reportDir);
      if (target !== path.resolve("work/webhook-classification")) throw new Error("Unexpected report destination");
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, "results.json"), JSON.stringify({ version: 1, runId: process.env.SPEKTRACE_HISTORICAL_VERIFY_DATABASE,
        syntheticOnly: true, passed: true,
        transport: "loopback HTTP with synthetic HMAC", worker: "real worker dispatcher invoked directly; no Redis scheduling claim",
        revisions: [{ id: old.id, label: "1.0.0 integer" }, { id: current.id, label: "2.0.0 number" }, { id: unsupported.id, label: "3.0.0 integer minimum 500" }],
        senders: [{ id: a.senderId, label: "Synthetic sender A" }, { id: b.senderId, label: "Synthetic sender B" }],
        rows, acceptedReceipts: accepted.length, groups: groups.length, groupedReceipts: 7,
        groupingChecks: { sameDriftMerged: same.group === equivalent.group, differentSenderSeparated: other.group !== equivalent.group,
          spoofIgnored: spoof.group === equivalent.group, differentDriftSeparated: new Set([missing.group, nil.group, equivalent.group]).size === 3,
          revisionSeparated: first.group !== equivalent.group, detailMemberCount: detail?.group.count },
        limitations: ["Active-at-acceptance binding, not inferred historical revision or verified runtime", "Synthetic amount allowlist rejects extra fields; not general lenient partner validation",
          "Empty bytes rejected before acceptance; empty JSON object is a required-field mismatch", "Receipt ids are ephemeral: disposable database is removed after the run", "No real provider, AI or business processing"] }, null, 2));
    }
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
