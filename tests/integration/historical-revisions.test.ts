import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireTestDatabaseUrl } from "@/lib/env";
import { historicalBindingImportSchema } from "@/lib/specs/historical-revisions";
import { importHistoricalBinding, lockHistoricalScope } from "@/server/services/historical-revisions";
import { submitIncident } from "@/server/services/incident-submission";
import { processIncidentValidation } from "@/server/services/process-incident-validation";
import { issueIngestionCredential } from "@/server/services/ingestion-credentials";
import { serializeIncident } from "@/server/serializers/incident-public";

const url = requireTestDatabaseUrl();
if (new URL(url).pathname.slice(1) !== process.env.SPEKTRACE_HISTORICAL_VERIFY_DATABASE ||
  !/^spektrace_test_history_[a-f0-9]{32}$/.test(process.env.SPEKTRACE_HISTORICAL_VERIFY_DATABASE ?? ""))
  throw new Error("Use verify:historical-revisions; these fixtures require its newly created disposable database");
const db = createPrismaClientForUrl(url);
vi.mock("@/lib/db", async (original) => ({ ...await original<typeof import("@/lib/db")>(), getPrisma: () => db }));
afterEach(() => vi.unstubAllEnvs());
afterAll(() => db.$disconnect());
const from = "2025-01-01T00:00:00.000Z";
const boundary = "2025-01-02T00:00:00.000Z";
const until = "2025-01-03T00:00:00.000Z";

async function fixture() {
  const w = await db.workspace.create({ data: { name: "Synthetic historical contracts", slug: `history-${randomUUID()}` } });
  async function revision(version: string, type: string, active: boolean) {
    const document = { openapi: "3.1.0", paths: { "/payments": { post: { requestBody: { content: {
      "application/json": { schema: { type: "object", required: ["amount"], properties: { amount: { type } } } },
    } } } } } };
    const sourceText = JSON.stringify(document);
    return db.apiSpec.create({ data: { workspaceId: w.id, apiKey: "payments", environment: "default", name: "Synthetic payments",
      version, openApiVersion: "3.1.0", sourceFilename: "synthetic.json", sourceText, parsedDocument: document,
      sourceSha256: createHash("sha256").update(sourceText).digest("hex"), isActive: active } });
  }
  const old = await revision("1.0.0", "string", false); const current = await revision("2.0.0", "integer", true);
  const deployment = await db.deploymentRecord.create({ data: { workspaceId: w.id, integrationKey: "synthetic-ci",
    sourceDeploymentId: "old-deploy", apiKey: "payments", environment: "default", apiSpecId: old.id } });
  vi.stubEnv("SPEKTRACE_HISTORICAL_BINDING_ALLOWLIST", JSON.stringify([{ integrationKey: "synthetic-ci", apiKey: "payments", environment: "default" }]));
  const binding = { integrationKey: "synthetic-ci", sourceIntervalId: "old-window", sourceDeploymentId: "old-deploy", apiKey: "payments",
    environment: "default", apiSpecId: old.id, sourceSha256: old.sourceSha256, validFrom: from, validUntil: boundary };
  const envelope = (occurredAt = from) => ({ source: "WEBHOOK" as const, sourceEventId: randomUUID(), apiKey: "payments", environment: "default",
    revisionSelectionMode: "historical" as const, httpMethod: "POST", requestPath: "/payments", statusCode: 400, occurredAt,
    sanitizedRequestBody: { amount: "100" } });
  return { w, old, current, deployment, binding, envelope };
}

describe("historical contracts against a real disposable database", () => {
  it("validates a late event against the old schema instead of the incompatible active schema", async () => {
    const f = await fixture(); await importHistoricalBinding(db, f.w.id, f.binding);
    const historical = await submitIncident(db, f.w.id, f.envelope());
    const live = await submitIncident(db, f.w.id, { ...f.envelope(), revisionSelectionMode: "active_at_ingestion" });
    expect(historical.incident.apiSpecId).toBe(f.old.id); expect(live.incident.apiSpecId).toBe(f.current.id);
    await processIncidentValidation(db, f.w.id, historical.incident.id); await processIncidentValidation(db, f.w.id, live.incident.id);
    const old = await db.incident.findUniqueOrThrow({ where: { id: historical.incident.id } });
    const current = await db.incident.findUniqueOrThrow({ where: { id: live.incident.id } });
    expect(old.validationStatus).toBe("PASSED"); expect(current.validationStatus).toBe("MISMATCH");
    expect(old.revisionSelection).toMatchObject({ authority: "operator_asserted_interval", runtimeVerified: false, apiSpecId: f.old.id,
      sourceSha256: f.old.sourceSha256, timeBasis: "reported_occurred_at", bindingId: expect.any(String) });
    expect(await db.apiSpec.findUniqueOrThrow({ where: { id: f.current.id } })).toMatchObject({ isActive: true });
    expect(await db.investigationInferenceRun.count({ where: { workspaceId: f.w.id } })).toBe(0);
    expect(old.approvedAt).toBeNull();
  });

  it("uses exact inclusive start/exclusive end and represents a rollback with a new old-revision interval", async () => {
    const f = await fixture(); await importHistoricalBinding(db, f.w.id, f.binding);
    expect((await submitIncident(db, f.w.id, f.envelope("2024-12-31T23:59:59.999Z"))).incident.apiSpecId).toBeNull();
    expect((await submitIncident(db, f.w.id, f.envelope(from))).incident.apiSpecId).toBe(f.old.id);
    expect((await submitIncident(db, f.w.id, f.envelope("2025-01-01T23:59:59.999Z"))).incident.apiSpecId).toBe(f.old.id);
    expect((await submitIncident(db, f.w.id, f.envelope(boundary))).incident.apiSpecId).toBeNull();
    await importHistoricalBinding(db, f.w.id, { ...f.binding, sourceIntervalId: "rollback-window", validFrom: boundary, validUntil: until });
    expect((await submitIncident(db, f.w.id, f.envelope(boundary))).incident.apiSpecId).toBe(f.old.id);
    expect((await submitIncident(db, f.w.id, f.envelope(until))).incident.apiSpecId).toBeNull();
  });

  it("keeps missing coverage unknown with no active fallback, including later imports and duplicate mode changes", async () => {
    const f = await fixture(); const payload = f.envelope();
    const first = await submitIncident(db, f.w.id, payload);
    expect(first.incident).toMatchObject({ apiSpecId: null, validationStatus: "UNSUPPORTED",
      revisionSelection: { reason: "HISTORICAL_COVERAGE_MISSING" }, validationEvidence: { reasonCode: "HISTORICAL_COVERAGE_MISSING" } });
    await importHistoricalBinding(db, f.w.id, f.binding);
    const retry = await submitIncident(db, f.w.id, payload);
    expect(retry.created).toBe(false); expect(retry.incident).toEqual(first.incident);
    await expect(submitIncident(db, f.w.id, { ...payload, revisionSelectionMode: "active_at_ingestion" })).rejects.toThrow("conflicts");
    await expect(submitIncident(db, f.w.id, { ...payload, revisionSelectionMode: undefined })).rejects.toThrow("conflicts");
    expect(await db.incident.count({ where: { workspaceId: f.w.id, sourceEventId: payload.sourceEventId } })).toBe(1);
    expect((await submitIncident(db, f.w.id, f.envelope())).incident.apiSpecId).toBe(f.old.id);
  });

  it.each([false, true])("refuses overlapping intervals even when same revision = %s", async (sameRevision) => {
    const f = await fixture(); await importHistoricalBinding(db, f.w.id, f.binding);
    const spec = sameRevision ? f.old : f.current;
    await db.deploymentRecord.create({ data: { workspaceId: f.w.id, integrationKey: "synthetic-ci", sourceDeploymentId: "other-deploy",
      apiKey: "payments", environment: "default", apiSpecId: spec.id } });
    await importHistoricalBinding(db, f.w.id, { ...f.binding, sourceIntervalId: "overlap", sourceDeploymentId: "other-deploy",
      apiSpecId: spec.id, sourceSha256: spec.sourceSha256 });
    const incident = (await submitIncident(db, f.w.id, f.envelope())).incident;
    expect(incident.apiSpecId).toBeNull(); expect(incident.revisionSelection).toMatchObject({ reason: "HISTORICAL_COVERAGE_AMBIGUOUS" });
  });

  it("bounds overflow, rejects future occurrence and never interprets malformed submillisecond time as coverage", async () => {
    const f = await fixture();
    for (let i = 0; i < 33; i++) await importHistoricalBinding(db, f.w.id, { ...f.binding, sourceIntervalId: `window-${i}` });
    for (const [time, reason] of [[from, "HISTORICAL_CANDIDATE_LIMIT"], ["2099-01-01T00:00:00.000Z", "HISTORICAL_OCCURRENCE_INVALID"],
      ["2025-01-01T00:00:00.0001Z", "HISTORICAL_OCCURRENCE_INVALID"]]) {
      const result = await submitIncident(db, f.w.id, f.envelope(time));
      expect(result.incident.apiSpecId).toBeNull(); expect(result.incident.revisionSelection).toMatchObject({ reason });
    }
  });

  it("enforces scope, hash, linkage, allowlist and immutable import identity with one audit", async () => {
    const f = await fixture(); const other = await fixture();
    const imported = await importHistoricalBinding(db, f.w.id, f.binding);
    expect((await importHistoricalBinding(db, f.w.id, f.binding)).created).toBe(false);
    expect(await db.auditLog.count({ where: { workspaceId: f.w.id, eventType: "HISTORICAL_BINDING_IMPORTED" } })).toBe(1);
    await expect(importHistoricalBinding(db, f.w.id, { ...f.binding, validUntil: until })).rejects.toMatchObject({ code: "IMPORT_CONFLICT" });
    for (const patch of [{ apiSpecId: other.old.id }, { sourceSha256: "f".repeat(64) }, { sourceDeploymentId: "missing" }, { apiSpecId: f.current.id, sourceSha256: f.current.sourceSha256 }])
      await expect(importHistoricalBinding(db, f.w.id, { ...f.binding, sourceIntervalId: randomUUID(), ...patch })).rejects.toMatchObject({ code: "INVALID_BINDING" });
    await expect(importHistoricalBinding(db, other.w.id, f.binding)).rejects.toMatchObject({ code: "INVALID_BINDING" });
    expect((await submitIncident(db, other.w.id, other.envelope())).incident.apiSpecId).toBeNull();
    expect((await submitIncident(db, f.w.id, { ...f.envelope(), environment: "other" })).incident.apiSpecId).toBeNull();
    expect((await submitIncident(db, f.w.id, { ...f.envelope(), apiKey: "other-service" })).incident.apiSpecId).toBeNull();
    vi.stubEnv("SPEKTRACE_HISTORICAL_BINDING_ALLOWLIST", "[]");
    await expect(importHistoricalBinding(db, f.w.id, { ...f.binding, sourceIntervalId: "not-allowed" })).rejects.toMatchObject({ code: "NOT_ALLOWLISTED" });
    await expect(db.contractRevisionInterval.update({ where: { id: imported.binding.id }, data: { validUntil: new Date(until) } })).rejects.toThrow();
    await expect(db.contractRevisionInterval.delete({ where: { id: imported.binding.id } })).rejects.toThrow();
  });

  it("keeps selection immutable in the database and labels untouched legacy rows as not recorded", async () => {
    const f = await fixture(); await importHistoricalBinding(db, f.w.id, f.binding);
    const selected = (await submitIncident(db, f.w.id, f.envelope())).incident;
    await expect(db.incident.update({ where: { id: selected.id }, data: { apiSpecId: f.current.id } })).rejects.toThrow();
    await expect(db.incident.update({ where: { id: selected.id }, data: { revisionSelection: { reason: "rewritten" } } })).rejects.toThrow();
    const legacy = await db.incident.create({ data: { workspaceId: f.w.id, apiKey: "payments", source: "WEBHOOK", sourceEventId: randomUUID(),
      httpMethod: "POST", requestPath: "/payments", statusCode: 400, occurredAt: new Date(from), apiSpecId: f.current.id } });
    expect(serializeIncident(legacy)).toMatchObject({ revisionSelectionMode: "legacy_not_recorded", revisionSelection: { reason: "LEGACY_SELECTION_NOT_RECORDED" } });
    expect((await db.incident.findUniqueOrThrow({ where: { id: legacy.id } })).revisionSelection).toBeNull();
  });

  it("authorizes import separately from ingestion and rejects forged scope, spec selection and oversized imports", async () => {
    const f = await fixture(); const credential = await issueIngestionCredential(db, f.w.id, "Synthetic history");
    const admin = `synthetic-admin-${randomUUID()}`;
    vi.stubEnv("SPEKTRACE_INTERNAL_API_TOKEN", admin); vi.stubEnv("SPEKTRACE_INTERNAL_WORKSPACE_ID", f.w.id);
    const { POST: importRoute } = await import("@/app/api/internal/contract-revision-intervals/route");
    const request = (token: string, body: unknown) => new Request("http://synthetic.test/api/internal/contract-revision-intervals", {
      method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    expect((await importRoute(request(credential.token, f.binding))).status).toBe(401);
    expect((await importRoute(request(admin, { ...f.binding, workspaceId: f.w.id }))).status).toBe(400);
    expect((await importRoute(request(admin, { ...f.binding, sourceIntervalId: "a".repeat(4097) }))).status).toBe(413);
    expect((await importRoute(request(admin, f.binding))).status).toBe(201);
    expect((await importRoute(request(admin, f.binding))).status).toBe(200);
    expect((await importRoute(request(admin, { ...f.binding, validUntil: until }))).status).toBe(409);
    const { POST: ingest } = await import("@/app/api/internal/incidents/route");
    const submit = (body: unknown, token = credential.token) => ingest(new Request("http://synthetic.test/api/internal/incidents", {
      method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
    expect((await submit({ ...f.envelope(), apiSpecId: f.current.id })).status).toBe(400);
    expect((await submit(f.envelope(), admin)).status).toBe(401);
    const response = await submit(f.envelope()); expect(response.status).toBe(202);
    const receipt = await response.json(); expect(Object.keys(receipt).sort()).toEqual(["created", "id", "receivedAt"]);
    expect((await db.incident.findUniqueOrThrow({ where: { id: receipt.id } })).apiSpecId).toBe(f.old.id);
    expect(historicalBindingImportSchema.safeParse({ ...f.binding, importedBy: "forged-user" }).success).toBe(false);
  });

  it("serializes a real import before a competing selection and preserves the committed snapshot", async () => {
    const f = await fixture();
    let release!: () => void; let acquired!: () => void;
    let holderPid = 0;
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`; holderPid = rows[0].pid;
      await lockHistoricalScope(tx, f.w.id, "payments", "default"); acquired(); await gate;
    }, { timeout: 10_000 });
    await ready;
    async function waitForBlockedCount(count: number) {
      for (let attempt = 0; attempt < 100; attempt++) {
        const rows = await db.$queryRaw<{ count: bigint }[]>`
          SELECT count(*) FROM pg_stat_activity WHERE ${holderPid} = ANY(pg_blocking_pids(pid))`;
        if (Number(rows[0].count) >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Competing transaction did not reach the advisory lock");
    }
    let pending: ReturnType<typeof submitIncident> | undefined;
    const importing = importHistoricalBinding(db, f.w.id, f.binding);
    try {
      await waitForBlockedCount(1);
      pending = submitIncident(db, f.w.id, f.envelope());
      await waitForBlockedCount(2);
    } finally { release(); await holder; }
    await importing;
    const selected = await pending!; expect(selected.incident.apiSpecId).toBe(f.old.id);
    await importHistoricalBinding(db, f.w.id, { ...f.binding, sourceIntervalId: "late-overlap" });
    expect((await db.incident.findUniqueOrThrow({ where: { id: selected.incident.id } })).revisionSelection).toEqual(selected.incident.revisionSelection);
  });

  it("returns one created and one duplicate for simultaneous first delivery, and conflicts on changed mode", async () => {
    const f = await fixture(); await importHistoricalBinding(db, f.w.id, f.binding);
    const payload = f.envelope();
    const pair = await Promise.all([submitIncident(db, f.w.id, payload), submitIncident(db, f.w.id, payload)]);
    expect(pair.map((result) => result.created).sort()).toEqual([false, true]);
    expect(pair[0].incident.id).toBe(pair[1].incident.id);
    const other = f.envelope();
    const changed = await Promise.allSettled([submitIncident(db, f.w.id, other), submitIncident(db, f.w.id, { ...other, revisionSelectionMode: "active_at_ingestion" })]);
    expect(changed.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = changed.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason.name).toBe("IncidentSubmissionConflictError");
    expect(await db.incident.count({ where: { workspaceId: f.w.id, sourceEventId: other.sourceEventId } })).toBe(1);
  });

  it("does not select a covering interval for a near-future occurrence", async () => {
    const f = await fixture(); const now = Date.now();
    await importHistoricalBinding(db, f.w.id, { ...f.binding, validFrom: new Date(now - 60_000).toISOString(), validUntil: new Date(now + 120_000).toISOString() });
    const incident = (await submitIncident(db, f.w.id, f.envelope(new Date(now + 60_000).toISOString()))).incident;
    expect(incident.apiSpecId).toBeNull(); expect(incident.revisionSelection).toMatchObject({ reason: "HISTORICAL_OCCURRENCE_INVALID" });
  });
});
