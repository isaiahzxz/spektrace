import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createExpressMonitor } from "../../packages/express-monitoring/src";

export const EXPRESS_FIXTURE_CLIENT = {
  applicationName: "Synthetic Express Payments", applicationVersion: "middleware-verify-1", platform: "node",
  sdkName: "Synthetic Consumer SDK", sdkVersion: "2.0",
};

export async function startExpressMonitoringFixture(baseUrl: string, ingestionToken: string) {
  async function app(capture: boolean) {
    const monitor = createExpressMonitor({ baseUrl, ingestionToken, apiKey: "payments-api", environment: "default",
      operationPath: "/payments", client: { ...EXPRESS_FIXTURE_CLIENT, applicationVersion: capture ? "body-on" : "body-off" },
      ...(capture ? { captureSanitizedBody: (req: { body?: unknown }) => req.body } : {}),
    });
    const fixture = express(); fixture.use(express.json({ limit: "32kb" }), monitor.middleware);
    fixture.post("/payments", (_req, res) => { res.status(400).set("X-Synthetic-App", "unchanged").json({ error: "Synthetic payment rejected" }); });
    const server = createServer(fixture);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
      async send() {
        const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/payments?token=synthetic-query-not-for-export`, {
          method: "POST", headers: { "content-type": "application/json", authorization: "Bearer synthetic-inbound-not-for-export" }, body: '{"amount":"100"}',
        });
        const body: unknown = await response.json();
        if (response.status !== 400 || response.headers.get("X-Synthetic-App") !== "unchanged" || JSON.stringify(body) !== '{"error":"Synthetic payment rejected"}') throw new Error("Express application response changed");
        if (!await monitor.flush(10_000) || monitor.stats().delivered !== 1) throw new Error("Express middleware delivery failed");
        return monitor.stats();
      },
      async close() {
        monitor.close(); server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      },
    };
  }
  const bodyOn = await app(true);
  try {
    const bodyOff = await app(false);
    return { bodyOn, bodyOff, close: async () => { await bodyOn.close(); await bodyOff.close(); } };
  } catch (error) { await bodyOn.close(); throw error; }
}
