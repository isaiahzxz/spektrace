import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireTestDatabaseUrl } from "@/lib/env";
import { importSenderBinding, revokeSenderBinding, resolveIncidentSender, lockSenderScope } from "@/server/services/sender-identity";
import { issueIngestionCredential, lockIngestionToken, revokeIngestionCredential, rotateIngestionCredential } from "@/server/services/ingestion-credentials";
import { submitIncident, submitIncidentWithIngestionToken } from "@/server/services/incident-submission";
import { serializeIncident } from "@/server/serializers/incident-public";
import { buildAgentEvidenceBundle } from "@/server/services/build-agent-evidence";
const packageRoot = process.env.SPEKTRACE_SENDER_PACKAGE_ROOT;
if (!packageRoot) throw new Error("Use the sender verification wrapper's installed package consumer");
const installedPackage = createRequire(path.join(packageRoot, "package.json"))("@spektrace/express-monitoring") as typeof import("../../packages/express-monitoring/src");
const { createExpressMonitor } = installedPackage;

const url = requireTestDatabaseUrl();
if (new URL(url).pathname.slice(1) !== process.env.SPEKTRACE_HISTORICAL_VERIFY_DATABASE ||
  !/^spektrace_test_history_[a-f0-9]{32}$/.test(process.env.SPEKTRACE_HISTORICAL_VERIFY_DATABASE ?? ""))
  throw new Error("Use verify:sender-identity; fixtures require its newly created disposable database");
const db = createPrismaClientForUrl(url);
vi.mock("@/lib/db", async (original) => ({ ...await original<typeof import("@/lib/db")>(), getPrisma: () => db }));
afterEach(() => vi.unstubAllEnvs());
afterAll(() => db.$disconnect());

async function fixture() {
  const w = await db.workspace.create({ data: { name: "Synthetic sender boundary", slug: `sender-${randomUUID()}` } });
  const key = await issueIngestionCredential(db, w.id, "Synthetic sender collector");
  const binding = { ingestionCredentialId: key.credential.id, apiKey: "payments", environment: "default", principalKind: "api_key_id" as const,
    principalRef: randomUUID(), senderKey: randomUUID(), displayName: "Synthetic checkout" };
  const envelope = () => ({ source: "WEBHOOK" as const, sourceEventId: randomUUID(), apiKey: "payments", environment: "default",
    httpMethod: "POST", requestPath: "/payments", statusCode: 400, occurredAt: "2025-01-01T00:00:00.000Z",
    senderReference: { principalRef: binding.principalRef, principalKind: binding.principalKind } });
  return { w, key, binding, envelope };
}
async function post(token: string, body: unknown) {
  const { POST } = await import("@/app/api/internal/incidents/route");
  return POST(new Request("http://synthetic.test/api/internal/incidents", { method: "POST",
    headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
}
async function waitForBlocked(holderPid: number, count = 1) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const rows = await db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM pg_stat_activity WHERE ${holderPid} = ANY(pg_blocking_pids(pid))`;
    if (Number(rows[0].count) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Competing operation did not reach the held database lock");
}

describe("sender identity without sender grouping or model calls", () => {
  it("attests only an exact collector binding and never upgrades a matching spoofed client header", async () => {
    const f = await fixture(); const registered = await importSenderBinding(db, f.w.id, f.binding);
    const attested = (await submitIncidentWithIngestionToken(db, f.key.token, f.envelope())).incident;
    expect(attested.senderId).toBe(registered.binding.senderId);
    expect(attested.senderProvenance).toMatchObject({ assurance: "integration_attested", reason: "INTEGRATION_ATTESTED",
      originalAuthenticationVerifiedBySpekTrace: false, collectorCredentialId: f.key.credential.id, bindingId: registered.binding.id });
    const spoofed = (await submitIncidentWithIngestionToken(db, f.key.token, { ...f.envelope(), senderReference: undefined,
      reportedClientRef: f.binding.principalRef })).incident;
    expect(spoofed.senderId).toBeNull(); expect(spoofed.senderBindingId).toBeNull();
    expect(spoofed.senderProvenance).toMatchObject({ assurance: "reported", reason: "REPORTED_HEADER_ONLY" });
    const internal = (await submitIncident(db, f.w.id, f.envelope())).incident;
    expect(internal.senderId).toBeNull(); expect(internal.senderProvenance).toMatchObject({ reason: "COLLECTOR_NOT_AUTHENTICATED" });
    expect(await db.investigationInferenceRun.count({ where: { workspaceId: f.w.id } })).toBe(0);
    expect(attested.approvedAt).toBeNull();
    const bundle = JSON.stringify(await buildAgentEvidenceBundle(db, f.w.id, attested.id));
    for (const value of [f.binding.principalRef, f.binding.senderKey, registered.binding.senderId, f.key.credential.id, f.key.token])
      expect(bundle).not.toContain(value);
  });

  it("isolates identical aliases by collector, service, environment, principal kind and workspace", async () => {
    const f = await fixture(); const other = await fixture();
    const registered = await importSenderBinding(db, f.w.id, f.binding);
    const secondKey = await issueIngestionCredential(db, f.w.id, "Another collector");
    for (const [token, payload] of [[secondKey.token, f.envelope()], [f.key.token, { ...f.envelope(), apiKey: "other-service" }],
      [f.key.token, { ...f.envelope(), environment: "staging" }], [f.key.token, { ...f.envelope(), senderReference: { principalRef: f.binding.principalRef, principalKind: "client_id" as const } }],
      [other.key.token, f.envelope()]] as const) {
      const result = await submitIncidentWithIngestionToken(db, token, payload);
      expect(result.incident.senderId).toBeNull(); expect(result.incident.senderProvenance).toMatchObject({ reason: "SENDER_UNMAPPED" });
    }
    await expect(importSenderBinding(db, other.w.id, { ...f.binding, senderKey: other.binding.senderKey })).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
    const otherBinding = await importSenderBinding(db, other.w.id, { ...f.binding, ingestionCredentialId: other.key.credential.id });
    expect(otherBinding.binding.senderId).not.toBe(registered.binding.senderId);
  });

  it("imports once under concurrent retries and conflicts on a changed canonical target or label", async () => {
    const f = await fixture();
    const pair = await Promise.all([importSenderBinding(db, f.w.id, f.binding), importSenderBinding(db, f.w.id, f.binding)]);
    expect(pair.map((result) => result.created).sort()).toEqual([false, true]); expect(pair[0].binding.id).toBe(pair[1].binding.id);
    expect(await db.auditLog.count({ where: { workspaceId: f.w.id, eventType: "SENDER_BINDING_REGISTERED" } })).toBe(1);
    for (const patch of [{ senderKey: randomUUID() }, { displayName: "Other sender" }])
      await expect(importSenderBinding(db, f.w.id, { ...f.binding, ...patch })).rejects.toMatchObject({ code: "BINDING_CONFLICT" });
    expect(await db.workspaceSender.count({ where: { workspaceId: f.w.id } })).toBe(1);
  });

  it("normalizes UUIDs before import, resolution and retry comparison", async () => {
    const f = await fixture(); const payload = f.envelope();
    const registration = await importSenderBinding(db, f.w.id, { ...f.binding, principalRef: f.binding.principalRef.toUpperCase(), senderKey: f.binding.senderKey.toUpperCase() });
    const first = await submitIncidentWithIngestionToken(db, f.key.token, { ...payload, senderReference: { ...payload.senderReference, principalRef: payload.senderReference.principalRef.toUpperCase() } });
    const retry = await submitIncidentWithIngestionToken(db, f.key.token, payload);
    expect(retry.created).toBe(false); expect(retry.incident.id).toBe(first.incident.id); expect(first.incident.senderId).toBe(registration.binding.senderId);
  });

  it("preserves unknown and attested snapshots after later import or revocation", async () => {
    const f = await fixture(); const payload = f.envelope();
    const unknown = await submitIncidentWithIngestionToken(db, f.key.token, payload);
    expect(unknown.incident.senderId).toBeNull();
    const registered = await importSenderBinding(db, f.w.id, f.binding);
    expect((await submitIncidentWithIngestionToken(db, f.key.token, payload)).incident).toEqual(unknown.incident);
    const attestedPayload = f.envelope(); const attested = await submitIncidentWithIngestionToken(db, f.key.token, attestedPayload);
    await revokeSenderBinding(db, f.w.id, registered.binding.id); await revokeSenderBinding(db, f.w.id, registered.binding.id);
    expect((await submitIncidentWithIngestionToken(db, f.key.token, attestedPayload)).incident).toEqual(attested.incident);
    const later = (await submitIncidentWithIngestionToken(db, f.key.token, f.envelope())).incident;
    expect(later.senderId).toBeNull(); expect(later.senderProvenance).toMatchObject({ reason: "SENDER_BINDING_REVOKED" });
    const reimport = await importSenderBinding(db, f.w.id, f.binding); expect(reimport.created).toBe(false); expect(reimport.binding.revokedAt).not.toBeNull();
    expect(await db.auditLog.count({ where: { workspaceId: f.w.id, eventType: "SENDER_BINDING_REVOKED" } })).toBe(1);
  });

  it("rejects changed claims and collectors on a logical-event retry without creating another incident", async () => {
    const f = await fixture(); await importSenderBinding(db, f.w.id, f.binding); const payload = f.envelope();
    const first = await post(f.key.token, payload); expect(first.status).toBe(202); const receipt = await first.json();
    expect(Object.keys(receipt).sort()).toEqual(["created", "id", "receivedAt"]);
    expect((await post(f.key.token, payload)).status).toBe(200);
    for (const patch of [{ senderReference: undefined }, { senderReference: { ...payload.senderReference, principalRef: randomUUID() } },
      { senderReference: { ...payload.senderReference, principalKind: "client_id" } }, { reportedClientRef: randomUUID() }])
      expect((await post(f.key.token, { ...payload, ...patch })).status).toBe(409);
    const rotated = await rotateIngestionCredential(db, f.w.id, f.key.credential.id);
    expect((await post(f.key.token, payload)).status).toBe(401); expect((await post(rotated.token, payload)).status).toBe(409);
    const newEvent = (await submitIncidentWithIngestionToken(db, rotated.token, f.envelope())).incident;
    expect(newEvent.senderId).toBeNull(); expect(newEvent.senderProvenance).toMatchObject({ reason: "SENDER_UNMAPPED" });
    expect(await db.incident.count({ where: { workspaceId: f.w.id, sourceEventId: payload.sourceEventId } })).toBe(1);
  });

  it("protects canonical records, mapping targets and incident attribution against rewriting", async () => {
    const f = await fixture(); const registered = await importSenderBinding(db, f.w.id, f.binding);
    const incident = (await submitIncidentWithIngestionToken(db, f.key.token, f.envelope())).incident;
    await expect(db.senderBinding.update({ where: { id: registered.binding.id }, data: { principalRef: randomUUID() } })).rejects.toThrow();
    await expect(db.senderBinding.delete({ where: { id: registered.binding.id } })).rejects.toThrow();
    await expect(db.workspaceSender.update({ where: { id: registered.binding.senderId }, data: { displayName: "Changed" } })).rejects.toThrow();
    await expect(db.incident.update({ where: { id: incident.id }, data: { senderId: null } })).rejects.toThrow();
    await expect(db.incident.update({ where: { id: incident.id }, data: { senderProvenance: { assurance: "verified" } } })).rejects.toThrow();
    await revokeSenderBinding(db, f.w.id, registered.binding.id);
    await expect(db.senderBinding.update({ where: { id: registered.binding.id }, data: { revokedAt: null } })).rejects.toThrow();
    const legacy = await db.incident.create({ data: { workspaceId: f.w.id, apiKey: "payments", source: "WEBHOOK", sourceEventId: randomUUID(),
      httpMethod: "POST", requestPath: "/payments", statusCode: 400, occurredAt: new Date() } });
    expect(serializeIncident(legacy)).toMatchObject({ senderId: null, senderProvenance: { assurance: "legacy_not_recorded" } });
  });

  it("keeps administrative binding and revocation routes separate from monitoring and rejects forged authority", async () => {
    const f = await fixture(); const admin = `synthetic-admin-${randomUUID()}`;
    vi.stubEnv("SPEKTRACE_INTERNAL_API_TOKEN", admin); vi.stubEnv("SPEKTRACE_INTERNAL_WORKSPACE_ID", f.w.id);
    const { POST: register } = await import("@/app/api/internal/sender-bindings/route");
    const { POST: revoke } = await import("@/app/api/internal/sender-bindings/[id]/revoke/route");
    const req = (token: string, body: unknown = {}) => new Request("http://synthetic.test/api/internal/sender-bindings", {
      method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    expect((await register(req(f.key.token, f.binding))).status).toBe(401);
    expect((await register(req(admin, { ...f.binding, workspaceId: f.w.id }))).status).toBe(400);
    expect((await register(req(admin, { ...f.binding, displayName: "x".repeat(4096) }))).status).toBe(413);
    const created = await register(req(admin, f.binding)); expect(created.status).toBe(201); const binding = await created.json();
    expect((await register(req(admin, f.binding))).status).toBe(200);
    expect((await revoke(req(f.key.token), { params: Promise.resolve({ id: binding.id }) })).status).toBe(401);
    expect((await revoke(req(admin), { params: Promise.resolve({ id: binding.id }) })).status).toBe(200);
    for (const patch of [{ senderId: binding.senderId }, { collectorCredentialId: f.key.credential.id }, { senderProvenance: { assurance: "integration_attested" } }])
      expect((await post(f.key.token, { ...f.envelope(), ...patch })).status).toBe(400);
    expect((await post(admin, f.envelope())).status).toBe(401);
  });

  it("makes binding and credential revocation wait for resolution's committed attribution snapshot", async () => {
    const f = await fixture(); const registered = await importSenderBinding(db, f.w.id, f.binding);
    let release!: () => void; let ready!: () => void; let holderPid = 0;
    const gate = new Promise<void>((resolve) => { release = resolve; }); const acquired = new Promise<void>((resolve) => { ready = resolve; });
    const holder = db.$transaction(async (tx) => {
      holderPid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid;
      await lockIngestionToken(tx, f.key.token);
      const selection = await resolveIncidentSender(tx, f.w.id, f.key.credential.id, "payments", "default", f.envelope().senderReference);
      ready(); await gate;
      return tx.incident.create({ data: { workspaceId: f.w.id, apiKey: "payments", source: "WEBHOOK", sourceEventId: randomUUID(), httpMethod: "POST",
        requestPath: "/payments", statusCode: 400, occurredAt: new Date(), collectorCredentialId: f.key.credential.id,
        senderId: selection.senderId, senderBindingId: selection.senderBindingId, senderProvenance: selection.provenance } });
    }, { timeout: 15_000 });
    await acquired;
    const revokeBinding = revokeSenderBinding(db, f.w.id, registered.binding.id);
    let revokeKey: ReturnType<typeof revokeIngestionCredential> | undefined;
    try {
      await waitForBlocked(holderPid);
      revokeKey = revokeIngestionCredential(db, f.w.id, f.key.credential.id);
      await waitForBlocked(holderPid, 2);
    } finally { release(); }
    const incident = await holder; await Promise.all([revokeBinding, revokeKey]);
    expect(incident.senderId).toBe(registered.binding.senderId);
    expect((await db.incident.findUniqueOrThrow({ where: { id: incident.id } })).senderProvenance).toEqual(incident.senderProvenance);
    expect((await post(f.key.token, f.envelope())).status).toBe(401);
  });

  it("rechecks credential revocation after waiting to register a binding", async () => {
    const f = await fixture(); let release!: () => void; let ready!: () => void; let pid = 0;
    const gate = new Promise<void>((resolve) => { release = resolve; }); const acquired = new Promise<void>((resolve) => { ready = resolve; });
    const holder = db.$transaction(async (tx) => {
      pid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid;
      await tx.ingestionCredential.update({ where: { id: f.key.credential.id }, data: { revokedAt: new Date() } }); ready(); await gate;
    }, { timeout: 10_000 });
    await acquired; const registering = importSenderBinding(db, f.w.id, f.binding);
    try { await waitForBlocked(pid); } finally { release(); await holder; }
    await expect(registering).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
    expect(await db.senderBinding.count({ where: { workspaceId: f.w.id } })).toBe(0);
  });

  it.each([true, false])("orders concurrent mapping import and first ingest, import first = %s", async (importFirst) => {
    const f = await fixture(); const payload = f.envelope();
    let release!: () => void; let ready!: () => void; let pid = 0;
    const gate = new Promise<void>((resolve) => { release = resolve; }); const acquired = new Promise<void>((resolve) => { ready = resolve; });
    const holder = db.$transaction(async (tx) => {
      pid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid;
      await lockSenderScope(tx, { ...f.binding, workspaceId: f.w.id }); ready(); await gate;
    }, { timeout: 10_000 });
    await acquired;
    let importing: ReturnType<typeof importSenderBinding> | undefined;
    let ingesting: ReturnType<typeof submitIncidentWithIngestionToken> | undefined;
    try {
      if (importFirst) importing = importSenderBinding(db, f.w.id, f.binding);
      else ingesting = submitIncidentWithIngestionToken(db, f.key.token, payload);
      await waitForBlocked(pid);
      if (importFirst) ingesting = submitIncidentWithIngestionToken(db, f.key.token, payload);
      else importing = importSenderBinding(db, f.w.id, f.binding);
      await waitForBlocked(pid, 2);
    } finally { release(); await holder; }
    const binding = await importing!; const incident = (await ingesting!).incident;
    expect(incident.senderId).toBe(importFirst ? binding.binding.senderId : null);
    expect((await submitIncidentWithIngestionToken(db, f.key.token, payload)).incident.senderId).toBe(incident.senderId);
  });

  it("serializes identical first deliveries and conflicts on simultaneous changed sender claims", async () => {
    const f = await fixture(); await importSenderBinding(db, f.w.id, f.binding); const payload = f.envelope();
    const pair = await Promise.all([submitIncidentWithIngestionToken(db, f.key.token, payload), submitIncidentWithIngestionToken(db, f.key.token, payload)]);
    expect(pair.map((result) => result.created).sort()).toEqual([false, true]); expect(pair[0].incident.id).toBe(pair[1].incident.id);
    const otherPrincipal = randomUUID();
    await importSenderBinding(db, f.w.id, { ...f.binding, principalRef: otherPrincipal, senderKey: randomUUID(), displayName: "Other synthetic sender" });
    const changed = f.envelope();
    const results = await Promise.allSettled([submitIncidentWithIngestionToken(db, f.key.token, changed),
      submitIncidentWithIngestionToken(db, f.key.token, { ...changed, senderReference: { ...changed.senderReference, principalRef: otherPrincipal } })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection?.status === "rejected" && rejection.reason.name).toBe("IncidentSubmissionConflictError");
    expect(await db.incident.count({ where: { workspaceId: f.w.id, sourceEventId: changed.sourceEventId } })).toBe(1);
  });

  it("forwards an app authentication alias over real Express HTTP while a matching header alone stays unverified", async () => {
    const f = await fixture(); const registered = await importSenderBinding(db, f.w.id, f.binding);
    const servers: Server[] = [];
    async function listen(server: Server) {
      servers.push(server); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }
    const { POST } = await import("@/app/api/internal/incidents/route");
    const receipts: string[] = [];
    const collector = await listen(createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const result = await POST(new Request("http://synthetic.test/api/internal/incidents", { method: "POST",
          headers: { authorization: req.headers.authorization ?? "" }, body: Buffer.concat(chunks).toString("utf8") }));
        const json = await result.json(); if (typeof json.id === "string") receipts.push(json.id);
        res.writeHead(result.status, { "content-type": "application/json" }).end(JSON.stringify(json));
      } catch { res.writeHead(500).end(); }
    }));
    const authenticated = new WeakSet<object>();
    const monitor = createExpressMonitor({ baseUrl: collector, ingestionToken: f.key.token, apiKey: "payments", operationPath: "/payments",
      resolveAuthenticatedSender: (req) => authenticated.has(req) ? f.envelope().senderReference : undefined });
    const app = express(); app.use(monitor.middleware);
    app.post("/authenticated", (req, res) => { authenticated.add(req); res.status(400).send("same response"); });
    app.post("/header-only", (_req, res) => res.status(400).send("same response"));
    const origin = await listen(createServer(app));
    try {
      for (const route of ["authenticated", "header-only"]) {
        const response = await fetch(`${origin}/${route}`, { method: "POST", headers: { "X-Client-ID": f.binding.principalRef, authorization: "Bearer synthetic-original-secret" } });
        expect(response.status).toBe(400); expect(await response.text()).toBe("same response");
        expect(await monitor.flush()).toBe(true);
      }
      expect(await monitor.flush()).toBe(true); expect(monitor.stats()).toMatchObject({ delivered: 2, failed: 0, pending: 0 });
      const first = await db.incident.findUniqueOrThrow({ where: { id: receipts[0] } }); const second = await db.incident.findUniqueOrThrow({ where: { id: receipts[1] } });
      expect(first.senderId).toBe(registered.binding.senderId); expect(second.senderId).toBeNull();
      expect(second.senderProvenance).toMatchObject({ assurance: "reported", reason: "REPORTED_HEADER_ONLY" });
      expect(JSON.stringify([first, second])).not.toContain("synthetic-original-secret");
    } finally {
      monitor.close(); for (const server of servers) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
    }
  });
});
