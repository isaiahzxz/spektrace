import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createOutboundObserver } from "@/lib/integration-observations/outbound-fetch";
import {
  detectIntegrationChange,
  observedBaselineShape,
} from "@/lib/integration-observations/detector";
import {
  observationSchema,
  coverageSchema,
} from "@/lib/integration-observations/contract";
import { projectSelectedShape } from "@/lib/integration-observations/shape";
import {
  startProvider,
  stopServer,
} from "../../scripts/lib/integration-observability-fixture";
async function collector() {
  const events: unknown[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const part of req) chunks.push(Buffer.from(part));
    events.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(202).end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No address");
  return { server, origin: `http://127.0.0.1:${address.port}`, events };
}
function options(collectorOrigin: string, providerOrigin: string) {
  return {
    collectorOrigin,
    providerOrigin,
    ingestionToken: `st_ingest_v1.${randomUUID()}.${randomBytes(32).toString("base64url")}`,
    integration: {
      key: "synthetic-payments",
      provider: "example-payments",
      environment: "test",
    },
  };
}
const context = { operation: { method: "GET" as const, path: "/payments" } };
describe("outbound capture and selected response evidence", () => {
  it("bounds a slow response clone without cancelling the application response", async () => {
    const c = await collector();
    const provider = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"amount":');
      const timer = setTimeout(() => res.end("100}"), 150);
      res.once("close", () => clearTimeout(timer));
    });
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    const address = provider.address();
    if (!address || typeof address === "string") throw Error("No fixture port");
    const origin = "http://127.0.0.1:" + address.port;
    const observer = createOutboundObserver({
      ...options(c.origin, origin),
      responsePointers: ["/amount"],
      bodyTimeoutMs: 25,
    });
    try {
      const response = await observer.fetch(
        origin + "/payments",
        undefined,
        context,
      );
      expect(await response.json()).toEqual({ amount: 100 });
      await observer.flush();
      const event = observationSchema.parse(
        c.events.find(
          (item: unknown) =>
            !!item &&
            typeof item === "object" &&
            "kind" in item &&
            item.kind === "observation",
        ),
      );
      expect(event.capture).toMatchObject({
        state: "OMITTED",
        omission: "BODY_TIMEOUT",
        projection: null,
      });
    } finally {
      observer.close();
      await stopServer(c.server);
      await stopServer(provider);
    }
  });

  it("keeps bodies off by default and preserves the real application response", async () => {
    const c = await collector(),
      p = await startProvider("payments"),
      observer = createOutboundObserver(options(c.origin, p.origin));
    try {
      const response = await observer.fetch(
        p.origin + "/payments",
        undefined,
        context,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        amount: 100,
        email: "synthetic-private@example.test",
      });
      expect((await observer.flush()).coverageDelivered).toBe(true);
      const event = observationSchema.parse(
        c.events.find(
          (e: unknown) =>
            !!e &&
            typeof e === "object" &&
            "kind" in e &&
            e.kind === "observation",
        ),
      );
      expect(event.capture).toMatchObject({
        state: "OFF",
        projection: null,
        pointers: [],
      });
      expect(JSON.stringify(c.events)).not.toContain("synthetic-private");
      expect(event.result).toMatchObject({
        kind: "HTTP",
        statusCode: 200,
        originMatched: true,
      });
    } finally {
      observer.close();
      await stopServer(c.server);
      await stopServer(p.server);
    }
  });
  it("exports selected presence/types, never values, without clearing or consuming the application body", async () => {
    const c = await collector(),
      p = await startProvider("payments"),
      observer = createOutboundObserver({
        ...options(c.origin, p.origin),
        responsePointers: ["/amount", "/email"],
        providerVersionHeader: "x-api-version",
      });
    try {
      const response = await observer.fetch(
        p.origin + "/payments",
        undefined,
        context,
      );
      const body = await response.text();
      expect(JSON.parse(body).email).toBe("synthetic-private@example.test");
      expect((await observer.flush()).settled).toBe(true);
      const event = observationSchema.parse(
        c.events.find(
          (e: unknown) =>
            !!e &&
            typeof e === "object" &&
            "kind" in e &&
            e.kind === "observation",
        ),
      );
      expect(event.capture.projection?.fields).toEqual([
        { pointer: "/amount", presence: "present", type: "integer" },
        { pointer: "/email", presence: "present", type: "string" },
      ]);
      expect(JSON.stringify(c.events)).not.toContain("synthetic-private");
      expect(JSON.stringify(c.events)).not.toContain("127.0.0.1");
      expect(event.result).toMatchObject({ providerVersion: "2026-10-27" });
    } finally {
      observer.close();
      await stopServer(c.server);
      await stopServer(p.server);
    }
  });
  it("records timeout separately and preserves explicit caller cancellation reasons", async () => {
    const c = await collector(),
      p = await startProvider("payments"),
      observer = createOutboundObserver(options(c.origin, p.origin));
    p.setMode("timeout");
    try {
      await expect(
        observer.fetch(
          p.origin + "/payments",
          { signal: AbortSignal.timeout(20) },
          context,
        ),
      ).rejects.toMatchObject({ name: "TimeoutError" });
      const controller = new AbortController(),
        reason = new Error("private caller reason");
      controller.abort(reason);
      await expect(
        observer.fetch(
          p.origin + "/payments",
          { signal: controller.signal },
          context,
        ),
      ).rejects.toBe(reason);
      await observer.flush();
      const events = c.events
        .filter(
          (e: unknown) =>
            !!e &&
            typeof e === "object" &&
            "kind" in e &&
            e.kind === "observation",
        )
        .map((e) => observationSchema.parse(e));
      expect(events.map((e) => e.result.kind)).toEqual(["TIMEOUT", "ABORTED"]);
      expect(events.every((e) => e.capture.state === "NO_RESPONSE")).toBe(true);
      expect(JSON.stringify(c.events)).not.toContain("private caller reason");
    } finally {
      observer.close();
      await stopServer(c.server);
      await stopServer(p.server);
    }
  });
  it("reports instrumented unsampled traffic even when no observations are selected", async () => {
    const c = await collector(),
      p = await startProvider("payments"),
      observer = createOutboundObserver({
        ...options(c.origin, p.origin),
        sampleRate: 0,
      });
    try {
      const response = await observer.fetch(
        p.origin + "/payments",
        undefined,
        context,
      );
      await response.body?.cancel();
      const result = await observer.flush();
      expect(result.stats).toMatchObject({
        seen: 1,
        sampled: 0,
        unsampled: 1,
        delivered: 0,
      });
      const snapshot = coverageSchema.parse(c.events[0]);
      expect(snapshot.counters).toMatchObject({ seen: 1, unsampled: 1 });
      expect(c.events).toHaveLength(1);
    } finally {
      observer.close();
      await stopServer(c.server);
      await stopServer(p.server);
    }
  });
  it("bounds response reads, preserves 5xx transport outcomes and does not wait for collector availability", async () => {
    const c = await collector();
    const p = await startProvider("payments");
    await stopServer(c.server);
    const observer = createOutboundObserver({
      ...options(c.origin, p.origin),
      responsePointers: ["/amount"],
      deliveryTimeoutMs: 100,
    });
    try {
      p.setMode("error");
      const response = await observer.fetch(
        p.origin + "/payments",
        undefined,
        context,
      );
      expect(response.status).toBe(503);
      expect((await response.json()).amount).toBe(100);
      const flushed = await observer.flush();
      expect(flushed.stats).toMatchObject({
        delivered: 0,
        deliveryUnconfirmed: 1,
      });
      expect(flushed.coverageDelivered).toBe(false);
    } finally {
      observer.close();
      await stopServer(p.server);
    }
  });
  it("limits metadata backlog and records dropped calls without interrupting provider responses", async () => {
    const c = await collector(),
      p = await startProvider("payments");
    p.setMode("timeout");
    const observer = createOutboundObserver({
      ...options(c.origin, p.origin),
      maxPending: 1,
    });
    try {
      const calls = await Promise.all([
        observer.fetch(p.origin + "/payments", undefined, context),
        observer.fetch(p.origin + "/payments", undefined, context),
      ]);
      for (const response of calls) expect(response.status).toBe(200);
      await observer.flush();
      expect(observer.stats()).toMatchObject({
        seen: 2,
        sampled: 2,
        dropped: 1,
        delivered: 1,
      });
    } finally {
      observer.close();
      await stopServer(c.server);
      await stopServer(p.server);
    }
  });
  it("omits oversized selected responses and leaves the full original response readable", async () => {
    const c = await collector();
    const server = createServer((_req, res) =>
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ amount: 100, private: "x".repeat(40000) })),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const addr = server.address();
    if (!addr || typeof addr === "string") throw Error("No port");
    const observer = createOutboundObserver({
      ...options(c.origin, "http://127.0.0.1:" + addr.port),
      responsePointers: ["/amount"],
    });
    try {
      const response = await observer.fetch(
        "http://127.0.0.1:" + addr.port + "/payments",
        undefined,
        context,
      );
      expect((await response.json()).private).toHaveLength(40000);
      await observer.flush();
      const event = observationSchema.parse(
        c.events.find(
          (e: unknown) =>
            !!e &&
            typeof e === "object" &&
            "kind" in e &&
            e.kind === "observation",
        ),
      );
      expect(event.capture).toMatchObject({
        state: "OMITTED",
        omission: "BODY_LIMIT",
        projection: null,
      });
      expect(JSON.stringify(c.events)).not.toContain("xxxx");
    } finally {
      observer.close();
      await stopServer(c.server);
      await stopServer(server);
    }
  });
  it("distinguishes observed response drift, contract mismatch, additions and no-response evidence", () => {
    const shape = projectSelectedShape({ amount: 100 }, ["/amount", "/status"]);
    const base = {
      version: 1 as const,
      kind: "observation" as const,
      sourceEventId: randomUUID(),
      callId: randomUUID(),
      attempt: 1,
      integration: {
        key: "payments",
        provider: "example",
        environment: "test",
      },
      operation: { method: "GET" as const, path: "/payments" },
      occurredAt: new Date().toISOString(),
      durationMs: 1,
      result: {
        kind: "HTTP" as const,
        statusCode: 200,
        originMatched: true,
        providerVersion: null,
      },
      capture: {
        state: "CAPTURED" as const,
        pointers: ["/amount", "/status"],
        projection: projectSelectedShape({ amount: "100" }, [
          "/amount",
          "/status",
        ]),
        omission: null,
      },
      correlation: null,
      sampleRate: 1,
    };
    const baseline = {
      id: randomUUID(),
      version: 1,
      origin: "OBSERVED",
      expectedShape: observedBaselineShape(shape),
    };
    expect(
      detectIntegrationChange(base, baseline),
      "DRIFT finding",
    ).toMatchObject({
      code: "DRIFT",
      changes: [{ pointer: "/amount", rule: "TYPE_CHANGED" }],
      causationEstablished: false,
    });
    expect(
      detectIntegrationChange(
        {
          ...base,
          capture: {
            ...base.capture,
            projection: projectSelectedShape({ amount: 100, status: "added" }, [
              "/amount",
              "/status",
            ]),
          },
        },
        baseline,
      ).code,
    ).toBe("ADDITION_ONLY");
    expect(
      detectIntegrationChange(
        {
          ...base,
          result: { kind: "TIMEOUT" },
          capture: {
            state: "NO_RESPONSE",
            pointers: [],
            projection: null,
            omission: null,
          },
        },
        baseline,
      ).code,
    ).toBe("NO_RESPONSE");
    expect(
      detectIntegrationChange(
        { ...base, result: { ...base.result, originMatched: false } },
        baseline,
      ).code,
    ).toBe("UNSUPPORTED");
    expect(() =>
      projectSelectedShape({ amount: 1 }, ["/__proto__/x"]),
    ).toThrow();
    expect(() =>
      observationSchema.parse({ ...base, payload: "raw-secret" }),
    ).toThrow();
  });
});
