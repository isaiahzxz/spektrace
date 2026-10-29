import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import express4 from "express4";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { createExpressMonitor, type ExpressMonitor, type MonitoringOptions } from "../../packages/express-monitoring/src";

const token = `st_ingest_v1.${randomUUID()}.${"a".repeat(43)}`;
const servers: Server[] = [];
const monitors: ExpressMonitor[] = [];
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function receiver(status = 202) {
  const records: Record<string, unknown>[] = [];
  const origin = await listen(createServer((req, res) => {
    let bytes = "";
    req.on("data", (chunk) => { bytes += chunk; });
    req.on("end", () => { records.push(JSON.parse(bytes)); res.writeHead(status).end(); });
  }));
  return { records, origin };
}
function monitor(origin: string, extra: Partial<MonitoringOptions> = {}) {
  const instance = createExpressMonitor({ baseUrl: origin, ingestionToken: token, apiKey: "payments-api", ...extra });
  monitors.push(instance); return instance;
}
afterEach(async () => {
  for (const instance of monitors.splice(0)) instance.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

for (const [name, factory] of [["Express 4", express4], ["Express 5", express]] as const) {
  describe(name, () => {
    it("captures one completed 4xx, preserves response, never reads default body or exports URLs/secrets", async () => {
      const sink = await receiver(); const instance = monitor(sink.origin);
      const app = factory(); app.use(instance.middleware, instance.middleware);
      app.get("/accounts/:id", (req, res) => {
        Object.defineProperty(req, "body", { get() { throw new Error("Body must not be read"); } });
        res.status(422).set("X-Application", "unchanged").send("unchanged response");
      });
      const origin = await listen(createServer(app));
      const response = await fetch(`${origin}/accounts/customer-private-id?access_token=private-query`, {
        headers: { authorization: "Bearer private-inbound", cookie: "session=private-cookie",
          "x-spektrace-application": "iOS App", "x-spektrace-application-version": "3.4", "x-spektrace-platform": "ios" },
      });
      expect(response.status).toBe(422); expect(response.headers.get("x-application")).toBe("unchanged");
      expect(await response.text()).toBe("unchanged response");
      expect(await instance.flush()).toBe(true); expect(sink.records).toHaveLength(1);
      expect(sink.records[0]).toMatchObject({ statusCode: 422, requestPath: "/__unresolved_operation__", client: { applicationName: "iOS App", applicationVersion: "3.4", platform: "ios" } });
      expect(Object.hasOwn(sink.records[0], "sanitizedRequestBody")).toBe(false);
      const serialized = JSON.stringify(sink.records);
      for (const secret of ["customer-private-id", "private-query", "private-inbound", "private-cookie", token]) expect(serialized.includes(secret)).toBe(false);
      expect((sink.records[0].client as Record<string, unknown>).sdkName).toBeUndefined();
      expect(instance.stats()).toMatchObject({ captured: 1, delivered: 1, operationUnresolved: 1, pending: 0 });
    });

    it("captures 400, 401, 403 and 404 only, including unmatched paths; ignores 2xx, 3xx, 5xx", async () => {
      const sink = await receiver(); const instance = monitor(sink.origin);
      const app = factory(); app.use(instance.middleware);
      app.get("/status/:code", (req, res) => { res.status(Number(req.params.code)).end(); });
      const origin = await listen(createServer(app));
      for (const status of [200, 302, 400, 401, 403, 500]) await (await fetch(`${origin}/status/${status}`, { redirect: "manual" })).text();
      expect((await fetch(`${origin}/missing/private-id`)).status).toBe(404);
      expect(await instance.flush()).toBe(true);
      expect(sink.records.map((event) => event.statusCode).sort()).toEqual([400, 401, 403, 404]);
      expect(new Set(sink.records.map((event) => event.sourceEventId)).size).toBe(4);
    });

    it("maps a nested dynamic router through explicit server configuration and includes an opted-in full body", async () => {
      const sink = await receiver();
      const instance = monitor(sink.origin, { captureSanitizedBody: (req) => req.body });
      const router = factory.Router(); router.post("/payments", instance.operation("/accounts/{accountId}/payments"), (_req, res) => { res.status(400).json({ error: "Rejected" }); });
      const app = factory(); app.use(factory.json({ limit: "32kb" }), instance.middleware);
      app.use("/accounts/:accountId", router);
      const origin = await listen(createServer(app));
      await fetch(`${origin}/accounts/private-id/payments?token=private`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"amount":"100"}' });
      expect(await instance.flush()).toBe(true);
      expect(sink.records[0]).toMatchObject({ requestPath: "/accounts/{accountId}/payments", sanitizedRequestBody: { amount: "100" } });
      expect(JSON.stringify(sink.records).includes("private-id")).toBe(false);
    });
  });
}

describe("monitoring protection and lifecycle", () => {
  it("keeps a reported client header separate from the authentication-context callback", async () => {
    const sink = await receiver(); const principalRef = randomUUID(); const reported = randomUUID();
    const instance = monitor(sink.origin, { resolveAuthenticatedSender: () => ({ principalRef: principalRef.toUpperCase(), principalKind: "api_key_id" }) });
    const origin = await listen(createServer((req, res) => instance.middleware(req, res, () => res.writeHead(401).end("unchanged"))));
    expect(await (await fetch(origin, { headers: { "X-Client-ID": reported, authorization: "Bearer private-key" } })).text()).toBe("unchanged");
    expect(await instance.flush()).toBe(true);
    expect(sink.records[0]).toMatchObject({ senderReference: { principalRef, principalKind: "api_key_id" }, reportedClientRef: reported });
    expect(JSON.stringify(sink.records)).not.toContain("private-key");
  });

  it("never upgrades headers into an authenticated claim and omits duplicate or malformed aliases", async () => {
    const sink = await receiver(); const id = randomUUID(); const instance = monitor(sink.origin);
    const origin = await listen(createServer((req, res) => instance.middleware(req, res, () => res.writeHead(400).end())));
    await fetch(origin, { headers: { "X-Client-ID": id } });
    await fetch(origin, { headers: { "X-Client-ID": "raw-key-must-not-leave", "X-API-Key": "another-private-key" } });
    await new Promise<void>((resolve, reject) => {
      const req = request(origin, { headers: ["Host", new URL(origin).host, "X-Client-ID", id, "x-client-id", id] }, (res) => { res.resume(); res.on("end", resolve); });
      req.on("error", reject); req.end();
    });
    expect(await instance.flush()).toBe(true); expect(sink.records).toHaveLength(3);
    expect(sink.records[0].reportedClientRef).toBe(id);
    expect(sink.records.every((row) => !Object.hasOwn(row, "senderReference"))).toBe(true);
    expect(sink.records.slice(1).every((row) => !Object.hasOwn(row, "reportedClientRef"))).toBe(true);
    expect(JSON.stringify(sink.records)).not.toContain("private-key");
    expect(JSON.stringify(sink.records)).not.toContain("raw-key-must-not-leave");
  });

  it("contains thrown, rejected, getter and invalid sender callbacks without losing incidents", async () => {
    const sink = await receiver(); let candidate: unknown;
    const instance = monitor(sink.origin, { resolveAuthenticatedSender: () => {
      if (candidate instanceof Error) throw candidate;
      // Runtime adversaries bypass the public TypeScript callback contract.
      return candidate as ReturnType<NonNullable<MonitoringOptions["resolveAuthenticatedSender"]>>;
    } });
    let getterRead = false;
    const getter = { principalKind: "client_id" }; Object.defineProperty(getter, "principalRef", { get() { getterRead = true; return randomUUID(); } });
    const origin = await listen(createServer((req, res) => instance.middleware(req, res, () => res.writeHead(403).end("same"))));
    for (const value of [new Error("private"), getter, { principalRef: "raw-secret", principalKind: "api_key_id" }, { principalRef: randomUUID(), principalKind: "client_id", verified: true }]) {
      candidate = value; expect(await (await fetch(origin)).text()).toBe("same");
    }
    const rejected = Promise.reject(new Error("private")); void rejected.catch(() => {}); candidate = rejected;
    expect(await (await fetch(origin)).text()).toBe("same");
    expect(await instance.flush()).toBe(true); expect(sink.records).toHaveLength(5);
    expect(sink.records.every((row) => !Object.hasOwn(row, "senderReference"))).toBe(true);
    expect(getterRead).toBe(false); expect(instance.stats().senderOmitted).toBe(5);
  });
  it("omits the whole body for secrets, cycles, getters, unsupported data and budget limits", async () => {
    const sink = await receiver(); let candidate: unknown;
    const instance = monitor(sink.origin, { operationPath: "/payments", captureSanitizedBody: () => candidate });
    const app = express(); app.use(instance.middleware); app.post("/payments", (_req, res) => { res.status(400).end(); });
    const origin = await listen(createServer(app));
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    let getterRead = false; const getter = Object.defineProperty({}, "amount", { enumerable: true, get() { getterRead = true; return 100; } });
    const bodies: unknown[] = [{ amount: "100", password: "do-not-export" }, { amount: "100", note: "user@example.com" }, cyclic, getter,
      new Date(), { amount: "x".repeat(513) }, new Array(201).fill(1), Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`k${i}`, 1])), [ , 1 ],
      { amount: "4111111111111111" }, { value: 4111111111111111 }, { amount: "[REDACTED]" }, { amount: "[OMITTED:DEPTH_LIMIT]" },
      { value: "AKIA1234567890123456" }, Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, "x".repeat(500)])),
      Object.create({ amount: 100 }), { toJSON: () => ({ amount: 100 }) }];
    let nested: unknown = 1; for (let i = 0; i < 10; i++) nested = { child: nested }; bodies.push(nested);
    for (const body of bodies) { candidate = body; await fetch(`${origin}/payments`, { method: "POST" }); }
    expect(await instance.flush()).toBe(true);
    expect(getterRead).toBe(false); expect(sink.records).toHaveLength(bodies.length);
    expect(sink.records.every((event) => !Object.hasOwn(event, "sanitizedRequestBody"))).toBe(true);
    expect(instance.stats().bodyOmitted).toBe(bodies.length);
  });

  it("contains synchronous and asynchronous body callback failures", async () => {
    const sink = await receiver(); let reject = false;
    const instance = monitor(sink.origin, { operationPath: "/payments", captureSanitizedBody: () => { if (reject) return Promise.reject(new Error("private")); throw new Error("private"); } });
    const app = express(); app.use(instance.middleware); app.get("/bad", (_req, res) => { res.status(400).send("same"); });
    const origin = await listen(createServer(app));
    expect(await (await fetch(`${origin}/bad`)).text()).toBe("same"); reject = true;
    expect(await (await fetch(`${origin}/bad`)).text()).toBe("same");
    expect(await instance.flush()).toBe(true); expect(instance.stats().bodyOmitted).toBe(2);
  });

  it("bounds queued plus in-flight work before body capture and closes without changing application responses", async () => {
    let arrived!: () => void; const arrival = new Promise<void>((resolve) => { arrived = resolve; });
    const slow = await listen(createServer(() => { arrived(); }));
    let captures = 0;
    const instance = monitor(slow, { operationPath: "/payments", maxPending: 2, concurrency: 1, timeoutMs: 1000, captureSanitizedBody: () => { captures++; return { amount: "100" }; } });
    const app = express(); app.use(instance.middleware); app.get("/bad", (_req, res) => { res.status(400).send("normal"); });
    const origin = await listen(createServer(app));
    expect(await (await fetch(`${origin}/bad`)).text()).toBe("normal"); await arrival;
    await fetch(`${origin}/bad`); await fetch(`${origin}/bad`);
    expect(captures).toBe(2); expect(instance.stats()).toMatchObject({ pending: 2, queueFull: 1 });
    expect(await instance.flush(20)).toBe(false);
    instance.close(); expect(await instance.flush()).toBe(true);
    expect(instance.stats()).toMatchObject({ pending: 0, shutdownDropped: 2, closed: true });
    expect((await fetch(`${origin}/bad`)).status).toBe(400); expect(captures).toBe(2);
  });

  it("times out a hung collector and releases capacity without retrying", async () => {
    let attempts = 0;
    const slow = await listen(createServer(() => { attempts++; }));
    const instance = monitor(slow, { timeoutMs: 40 });
    const app = express(); app.use(instance.middleware); app.get("/bad", (_req, res) => { res.status(400).end(); });
    const origin = await listen(createServer(app)); await fetch(`${origin}/bad`);
    expect(await instance.flush()).toBe(true); expect(instance.stats()).toMatchObject({ timedOut: 1, pending: 0 }); expect(attempts).toBe(1);
  });

  it("does not follow redirects or forward credentials to the redirect destination", async () => {
    let leaked = false;
    const destination = await listen(createServer((_req, res) => { leaked = true; res.writeHead(202).end(); }));
    const redirect = await listen(createServer((_req, res) => { res.writeHead(307, { location: destination }).end(); }));
    const instance = monitor(redirect); const app = express(); app.use(instance.middleware); app.get("/bad", (_req, res) => { res.status(400).end(); });
    const origin = await listen(createServer(app)); await fetch(`${origin}/bad`); await instance.flush();
    expect(leaked).toBe(false); expect(instance.stats().failed).toBe(1);
  });

  it("keeps application responses working if the collector resets the connection", async () => {
    const unavailable = await listen(createServer((req) => { req.socket.destroy(); }));
    const instance = monitor(unavailable);
    const app = express(); app.use(instance.middleware); app.get("/bad", (_req, res) => { res.status(403).send("unchanged"); });
    const origin = await listen(createServer(app)); const response = await fetch(`${origin}/bad`);
    expect(response.status).toBe(403); expect(await response.text()).toBe("unchanged");
    expect(await instance.flush()).toBe(true); expect(instance.stats()).toMatchObject({ failed: 1, pending: 0 });
  });

  it("omits opted-in bodies if an operation is unresolved and rejects duplicate client headers", async () => {
    const sink = await receiver(); let called = false;
    const instance = monitor(sink.origin, { captureSanitizedBody: () => { called = true; return { amount: "100" }; } });
    const server = createServer((req, res) => instance.middleware(req, res, () => { res.writeHead(400).end(); }));
    const origin = await listen(server);
    await new Promise<void>((resolve, reject) => {
      const req = request(origin, { headers: ["Host", new URL(origin).host, "x-spektrace-application", "First", "x-spektrace-application", "Second"] }, (res) => { res.resume(); res.on("end", resolve); });
      req.on("error", reject); req.end();
    });
    expect(await instance.flush()).toBe(true); expect(called).toBe(false);
    expect(sink.records[0].client).toEqual({}); expect(Object.hasOwn(sink.records[0], "sanitizedRequestBody")).toBe(false);
  });

  it("does not report a response closed before finish", async () => {
    const sink = await receiver(); const instance = monitor(sink.origin);
    const app = express(); app.use(instance.middleware); app.get("/aborted", (_req, res) => { res.status(400); res.destroy(); });
    const origin = await listen(createServer(app)); await expect(fetch(`${origin}/aborted`)).rejects.toThrow();
    await instance.flush(); expect(sink.records).toHaveLength(0); expect(instance.stats().captured).toBe(0);
  });

  it("rejects unsafe configuration without reflecting credentials or endpoint content", () => {
    for (const baseUrl of ["http://example.com", "https://user:private@example.com", "https://example.com?secret=private", "https://example.com/#private", "https://example.com/path", "file:///private"]) {
      expect(() => createExpressMonitor({ baseUrl, ingestionToken: token, apiKey: "payments-api" })).toThrow("Invalid monitoring endpoint");
    }
    for (const operationPath of ["/users/private@example.com", "/users/12345", "/users/:id", "/users/{id}?token=x", "/users/../private"]) {
      expect(() => monitor("http://127.0.0.1", { operationPath })).toThrow("Invalid operation template");
    }
  });
});
