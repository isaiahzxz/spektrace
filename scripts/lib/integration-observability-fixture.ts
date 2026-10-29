import { createServer, type IncomingMessage } from "node:http";
import type { Server } from "node:http";
import { once } from "node:events";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { issueIngestionCredential } from "@/server/services/ingestion-credentials";
import {
  handleIntegrationIngestion,
  handleResponseBaseline,
} from "@/server/integration-observations/http";
import { routeWorkerJob } from "@/server/services/route-worker-job";
export async function stopServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
export async function startCollector(db: PrismaClient) {
  const server = createServer(async (req, res) => {
    try {
      if (
        req.method !== "POST" ||
        ![
          "/api/internal/integration-observations",
          "/api/internal/workflow-outcomes",
          "/api/internal/response-baselines",
        ].includes(req.url ?? "")
      ) {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const part of req) {
        const chunk = Buffer.from(part);
        bytes += chunk.length;
        if (bytes > 32768) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const headers = new Headers();
      for (let i = 0; i < req.rawHeaders.length; i += 2)
        headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
      const request = new Request(`http://127.0.0.1${req.url}`, {
        method: "POST",
        headers,
        body: Buffer.concat(chunks),
      });
      const response =
        req.url === "/api/internal/response-baselines"
          ? await handleResponseBaseline(request, db)
          : await handleIntegrationIngestion(
              request,
              db,
              req.url === "/api/internal/workflow-outcomes"
                ? "outcome"
                : "observation",
            );
      res
        .writeHead(response.status, { "content-type": "application/json" })
        .end(await response.text());
    } catch {
      res.writeHead(503).end('{"error":"Synthetic collector unavailable"}');
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Missing collector address");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}
export async function startProvider(kind: "payments" | "crm") {
  let mode: "base" | "drift" | "timeout" | "error" = "base";
  const server = createServer((_req: IncomingMessage, res) => {
    if (mode === "timeout") {
      const timer = setTimeout(() => {
        if (!res.destroyed)
          res.writeHead(200, { "content-type": "application/json" }).end("{}");
      }, 150);
      res.once("close", () => clearTimeout(timer));
      return;
    }
    const body =
      kind === "payments"
        ? {
            amount: mode === "drift" ? "100" : 100,
            status: "ok",
            email: "synthetic-private@example.test",
          }
        : {
            count: mode === "drift" ? "1" : 1,
            results: [
              {
                id: "private-customer-id",
                email: "synthetic-crm@example.test",
              },
            ],
          };
    res
      .writeHead(mode === "error" ? 503 : 200, {
        "content-type": "application/json",
        "x-api-version": "2026-10-27",
      })
      .end(JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Missing provider address");
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    setMode(next: typeof mode) {
      mode = next;
    },
  };
}
export async function observabilityFixture(
  db: PrismaClient,
  workspaceId?: string,
) {
  const workspace = workspaceId
    ? await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
    : await db.workspace.create({
        data: {
          name: "Synthetic integration observability",
          slug: `observe-${randomUUID()}`,
        },
      });
  const key = await issueIngestionCredential(
    db,
    workspace.id,
    "Synthetic outbound observer",
  );
  return { workspace, key, adminToken: randomBytes(32).toString("hex") };
}
export async function drainIntegrationWork(
  db: PrismaClient,
  workspaceId: string,
) {
  const rows = await db.outboxEvent.findMany({
    where: {
      workspaceId,
      eventType: {
        in: [
          "INTEGRATION_OBSERVATION_REQUESTED",
          "INTEGRATION_OUTCOME_REQUESTED",
        ],
      },
    },
    orderBy: { createdAt: "asc" },
  });
  for (const row of rows)
    await routeWorkerJob(db, {
      workspaceId,
      task: row.integrationObservationId
        ? "observe-integration"
        : "link-integration-outcome",
      integrationObservationId: row.integrationObservationId ?? undefined,
      integrationOutcomeId: row.integrationOutcomeId ?? undefined,
    });
}
export async function requestSpec(db: PrismaClient, workspaceId: string) {
  const bodySchema = {
    type: "object",
    required: ["amount"],
    properties: { amount: { type: "integer" }, status: { type: "string" } },
  };
  const content = { "application/json": { schema: bodySchema } };
  const post = { requestBody: { content }, responses: { "200": { content } } };
  const document = { openapi: "3.1.0", paths: { "/payments": { post } } };
  const source = JSON.stringify(document);
  return db.apiSpec.create({
    data: {
      workspaceId,
      apiKey: "synthetic-payments",
      environment: "test",
      name: "Synthetic payments request and response contract",
      version: "1.0.0",
      openApiVersion: "3.1.0",
      sourceFilename: "synthetic.json",
      sourceText: source,
      parsedDocument: document,
      sourceSha256: createHash("sha256").update(source).digest("hex"),
      isActive: true,
    },
  });
}
