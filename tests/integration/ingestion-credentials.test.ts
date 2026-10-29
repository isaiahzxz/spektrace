import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, rmdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { IncidentSource } from "@/generated/prisma/client";
import { createPrismaClientForUrl } from "@/lib/db";
import { requireTestDatabaseUrl } from "@/lib/env";
import { generateIngestionToken } from "@/lib/ingestion/credential-token";
import { authenticateIngestionToken, issueIngestionCredential, revokeIngestionCredential, rotateIngestionCredential } from "@/server/services/ingestion-credentials";
import { submitIncidentWithIngestionToken } from "@/server/services/incident-submission";

const db = createPrismaClientForUrl(requireTestDatabaseUrl());
vi.mock("@/lib/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/db")>(), getPrisma: () => db,
}));
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
let baselineIds: string[];
let baselineDigest: string;
const createdKeys: { workspaceId: string; id: string }[] = [];
async function workspace() {
  return db.workspace.create({ data: { name: "Synthetic credential check", slug: `credential-${randomUUID()}` } });
}
async function issue(workspaceId: string) {
  const result = await issueIngestionCredential(db, workspaceId, "Synthetic monitoring");
  createdKeys.push(result.credential);
  return result;
}
function envelope(event = randomUUID()) {
  return { source: IncidentSource.WEBHOOK, sourceEventId: event, apiKey: "shared-service-name", environment: "default",
    httpMethod: "POST", requestPath: "/payments", statusCode: 400, occurredAt: "2026-10-21T12:00:00.000Z",
    sanitizedRequestBody: { amount: "100" } };
}
async function post(token: string, payload: unknown = envelope()) {
  const { POST } = await import("@/app/api/internal/incidents/route");
  return POST(new Request("http://synthetic.test/api/internal/incidents", { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(payload) }));
}
beforeAll(async () => {
  const rows = await db.incident.findMany({ orderBy: { id: "asc" } });
  baselineIds = rows.map((r) => r.id); baselineDigest = digest(rows);
});
afterAll(async () => {
  try {
    expect(digest(await db.incident.findMany({ where: { id: { in: baselineIds } }, orderBy: { id: "asc" } }))).toBe(baselineDigest);
  } finally {
    try { for (const key of createdKeys) await revokeIngestionCredential(db, key.workspaceId, key.id); }
    finally { await db.$disconnect(); }
  }
});

describe("non-reset workspace ingestion credentials", () => {
  it("issues, lists, rotates and revokes through the operator CLI without printing secrets", async () => {
    const w = await workspace();
    const root = path.join(os.homedir(), ".spektrace-credential-test");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(path.join(root, "operator-"));
    const firstFile = path.join(dir, "first.json"); const nextFile = path.join(dir, "next.json");
    const invoke = (...args: string[]) => spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/manage-ingestion-credentials.ts", ...args,
      "--workspace", w.id], { encoding: "utf8", windowsHide: true, timeout: 15_000,
      env: { ...process.env, DATABASE_URL: requireTestDatabaseUrl() } });
    try {
      const issued = invoke("issue", "--secret-file", firstFile);
      expect(issued.status).toBe(0);
      const first = JSON.parse(await readFile(firstFile, "utf8")) as { credentialId: string; token: string };
      createdKeys.push({ workspaceId: w.id, id: first.credentialId });
      expect(issued.stdout.includes(first.token)).toBe(false); expect(issued.stderr.includes(first.token)).toBe(false);
      const listed = invoke("list"); expect(listed.status).toBe(0);
      expect(JSON.parse(listed.stdout)[0].id).toBe(first.credentialId);
      expect(listed.stdout.includes(first.token)).toBe(false);
      const overwrite = invoke("rotate", "--id", first.credentialId, "--secret-file", firstFile);
      expect(overwrite.status).toBe(1);
      expect((await authenticateIngestionToken(db, first.token)).workspaceId).toBe(w.id);
      const rotated = invoke("rotate", "--id", first.credentialId, "--secret-file", nextFile);
      expect(rotated.status).toBe(0);
      const next = JSON.parse(await readFile(nextFile, "utf8")) as { credentialId: string; token: string };
      createdKeys.push({ workspaceId: w.id, id: next.credentialId });
      expect(rotated.stdout.includes(next.token)).toBe(false); expect(rotated.stderr.includes(next.token)).toBe(false);
      expect((await post(first.token)).status).toBe(401); expect((await post(next.token)).status).toBe(202);
      expect(invoke("revoke", "--id", next.credentialId).status).toBe(0);
      expect((await post(next.token)).status).toBe(401);
    } finally {
      await rm(firstFile, { force: true }); await rm(nextFile, { force: true }); await rmdir(dir);
    }
  }, 30_000);

  it("derives workspace from the key, isolates identical event IDs and returns receipts only", async () => {
    const a = await workspace(); const b = await workspace();
    const ka = await issue(a.id); const kb = await issue(b.id);
    const payload = envelope();
    const ra = await post(ka.token, payload); const rb = await post(kb.token, payload);
    expect(ra.status).toBe(202); expect(rb.status).toBe(202);
    const receiptA = await ra.json(); const receiptB = await rb.json();
    expect(Object.keys(receiptA).sort()).toEqual(["created", "id", "receivedAt"]);
    expect(receiptA.id).not.toBe(receiptB.id);
    expect((await db.incident.findUniqueOrThrow({ where: { id: receiptA.id } })).workspaceId).toBe(a.id);
    expect((await db.incident.findUniqueOrThrow({ where: { id: receiptB.id } })).workspaceId).toBe(b.id);
    expect((await post(ka.token, payload)).status).toBe(200);
    expect(await db.incident.count({ where: { workspaceId: a.id, sourceEventId: payload.sourceEventId } })).toBe(1);
    expect((await post(ka.token, { ...envelope(), workspaceId: b.id })).status).toBe(400);
    const rows = await db.ingestionCredential.findMany({ where: { workspaceId: a.id } });
    expect(rows[0].tokenSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(ka.token);
    expect(JSON.stringify(await db.auditLog.findMany({ where: { workspaceId: a.id } }))).not.toContain(ka.token);
  });

  it("rejects admin tokens for ingestion and ingestion keys for admin reads and spec writes", async () => {
    const w = await workspace(); const key = await issue(w.id);
    const oldToken = process.env.SPEKTRACE_INTERNAL_API_TOKEN;
    const oldWorkspace = process.env.SPEKTRACE_INTERNAL_WORKSPACE_ID;
    const admin = `synthetic-admin-${randomUUID()}`;
    process.env.SPEKTRACE_INTERNAL_API_TOKEN = admin;
    process.env.SPEKTRACE_INTERNAL_WORKSPACE_ID = w.id;
    try {
      expect((await post(admin)).status).toBe(401);
      const { GET } = await import("@/app/api/internal/incidents/[id]/route");
      const { POST } = await import("@/app/api/internal/specs/activate/route");
      const req = () => new Request("http://synthetic.test/api/internal/specs/activate", {
        method: "POST", headers: { authorization: `Bearer ${key.token}` }, body: "{}" });
      expect((await GET(req(), { params: Promise.resolve({ id: randomUUID() }) })).status).toBe(401);
      expect((await POST(req())).status).toBe(401);
      // A misconfigured admin token must not promote an ingestion key into an admin credential.
      process.env.SPEKTRACE_INTERNAL_API_TOKEN = key.token;
      expect((await POST(req())).status).toBe(401);
    } finally {
      if (oldToken === undefined) delete process.env.SPEKTRACE_INTERNAL_API_TOKEN; else process.env.SPEKTRACE_INTERNAL_API_TOKEN = oldToken;
      if (oldWorkspace === undefined) delete process.env.SPEKTRACE_INTERNAL_WORKSPACE_ID; else process.env.SPEKTRACE_INTERNAL_WORKSPACE_ID = oldWorkspace;
    }
  });

  it("revokes idempotently and rejects duplicates, expired, altered and unknown keys identically", async () => {
    const w = await workspace(); const key = await issue(w.id); const expired = await issue(w.id);
    const payload = envelope(); expect((await post(key.token, payload)).status).toBe(202);
    await revokeIngestionCredential(db, w.id, key.credential.id);
    await revokeIngestionCredential(db, w.id, key.credential.id);
    await db.ingestionCredential.update({ where: { id: expired.credential.id }, data: {
      createdAt: new Date(Date.now() - 3 * 86400_000), expiresAt: new Date(Date.now() - 86400_000),
    } });
    const changed = key.token.slice(0, -1) + (key.token.endsWith("A") ? "B" : "A");
    for (const token of [key.token, expired.token, changed, generateIngestionToken().token]) {
      const response = await post(token, payload);
      expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: "Unauthorized" });
    }
    expect(await db.auditLog.count({ where: { workspaceId: w.id, eventType: "INGESTION_CREDENTIAL_REVOKED" } })).toBe(1);
  });

  it("rotates atomically once and refuses cross-workspace lifecycle operations", async () => {
    const w = await workspace(); const other = await workspace(); const key = await issue(w.id);
    await expect(revokeIngestionCredential(db, other.id, key.credential.id)).rejects.toThrow("unavailable");
    await expect(rotateIngestionCredential(db, other.id, key.credential.id)).rejects.toThrow("unavailable");
    const replacement = await rotateIngestionCredential(db, w.id, key.credential.id);
    createdKeys.push(replacement.credential);
    expect((await post(key.token)).status).toBe(401);
    expect((await post(replacement.token)).status).toBe(202);
    await expect(rotateIngestionCredential(db, w.id, key.credential.id)).rejects.toThrow("unavailable");
    expect(await db.ingestionCredential.count({ where: { workspaceId: w.id } })).toBe(2);
    expect(await db.auditLog.count({ where: { workspaceId: w.id, eventType: "INGESTION_CREDENTIAL_ROTATED" } })).toBe(1);
  });

  it("leaves the old key active when delivery or replacement persistence fails", async () => {
    const w = await workspace(); const key = await issue(w.id);
    await expect(rotateIngestionCredential(db, w.id, key.credential.id, async () => { throw new Error("delivery refused"); })).rejects.toThrow("delivery refused");
    const failing = db.$extends({ query: { auditLog: { async create() { throw new Error("synthetic audit refused"); } } } });
    await expect(rotateIngestionCredential(failing as unknown as typeof db, w.id, key.credential.id)).rejects.toThrow("synthetic audit refused");
    expect((await authenticateIngestionToken(db, key.token)).workspaceId).toBe(w.id);
    expect(await db.ingestionCredential.count({ where: { workspaceId: w.id } })).toBe(1);
    await expect(issueIngestionCredential(db, w.id, "Delivery failure", async () => { throw new Error("delivery refused"); })).rejects.toThrow("delivery refused");
    expect(await db.ingestionCredential.count({ where: { workspaceId: w.id } })).toBe(1);
  });

  it("waits for in-flight ingestion before revoking and rejects later duplicate access", async () => {
    const w = await workspace(); const key = await issue(w.id); const payload = envelope();
    let unlock!: () => void; let signalLocked!: () => void;
    const gate = new Promise<void>((r) => { unlock = r; });
    const locked = new Promise<void>((r) => { signalLocked = r; });
    const delaying = db.$extends({ query: { incident: { async create({ args, query }) {
      signalLocked(); await gate; return query(args);
    } } } });
    const pending = submitIncidentWithIngestionToken(delaying as unknown as typeof db, key.token, payload);
    await locked;
    const waiter = `credential-revoker-${randomUUID()}`;
    const revokerUrl = new URL(requireTestDatabaseUrl());
    revokerUrl.searchParams.set("application_name", waiter);
    const revoker = createPrismaClientForUrl(revokerUrl.toString());
    const revocation = revokeIngestionCredential(revoker, w.id, key.credential.id);
    try {
      let blocked = false;
      for (let i = 0; i < 40; i++) {
        const locks = await db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM pg_stat_activity
          WHERE application_name = ${waiter} AND wait_event_type = 'Lock'
          AND query LIKE 'SELECT id FROM ingestion_credentials%FOR UPDATE'`;
        if (Number(locks[0].count) > 0) { blocked = true; break; }
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(blocked).toBe(true);
    } finally { unlock(); }
    const accepted = await pending;
    try { await revocation; } finally { await revoker.$disconnect(); }
    expect(accepted.created).toBe(true);
    expect((await post(key.token, payload)).status).toBe(401);
    await expect(submitIncidentWithIngestionToken(db, key.token, payload)).rejects.toThrow("Unauthorized");
  });

  it("rechecks revocation after request parsing, including duplicate submissions", async () => {
    const w = await workspace(); const key = await issue(w.id); const payload = envelope();
    expect((await post(key.token, payload)).status).toBe(202);
    let signalReading!: () => void;
    const reading = new Promise<void>((r) => { signalReading = r; });
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    const request = new Request("http://synthetic.test/api/internal/incidents", {
      method: "POST", headers: { authorization: `Bearer ${key.token}` }, body: "{}",
    });
    Object.defineProperty(request, "body", { get() { signalReading(); return stream; } });
    const { POST } = await import("@/app/api/internal/incidents/route");
    const pending = POST(request);
    await reading;
    await revokeIngestionCredential(db, w.id, key.credential.id);
    controller.enqueue(new TextEncoder().encode(JSON.stringify(payload))); controller.close();
    expect((await pending).status).toBe(401);
    expect(await db.incident.count({ where: { workspaceId: w.id } })).toBe(1);
  });

  it("rejects oversized streamed JSON before parsing it", async () => {
    const w = await workspace(); const key = await issue(w.id);
    expect((await post(key.token, "x".repeat(65_536))).status).toBe(413);
    expect(await db.incident.count({ where: { workspaceId: w.id } })).toBe(0);
  });
});
