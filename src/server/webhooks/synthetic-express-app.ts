import express, { type ErrorRequestHandler } from "express";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { parseIngestionAuthorization } from "@/lib/ingestion/credential-token";
import { sanitizeSyntheticWebhook } from "@/lib/ingestion/synthetic-webhook";
import { authenticateIngestionToken, IngestionUnauthorizedError } from "@/server/services/ingestion-credentials";
import { acceptSyntheticWebhook, WebhookConflictError } from "@/server/services/accept-synthetic-webhook";

export function createSyntheticWebhookApp(db: PrismaClient) {
  const app = express();
  app.disable("x-powered-by");
  app.post("/synthetic/webhooks/payments", async (req, res, next) => {
    const authorization = req.rawHeaders.filter((_value, index, all) => index % 2 === 1 && all[index - 1].toLowerCase() === "authorization");
    const auth = authorization.length === 1 ? parseIngestionAuthorization(authorization[0]) : null;
    if (!auth) { res.status(401).json({ error: "Unauthorized" }); return; }
    try { await authenticateIngestionToken(db, auth.token); next(); }
    catch (error) { res.status(error instanceof IngestionUnauthorizedError ? 401 : 503).json({ error: error instanceof IngestionUnauthorizedError ? "Unauthorized" : "Storage unavailable" }); }
  }, express.json({ limit: 4096, strict: true, inflate: false }), async (req, res) => {
    if (!req.is("application/json")) { res.status(415).json({ error: "JSON required" }); return; }
    const eventHeaders = req.rawHeaders.filter((_value, index, all) => index % 2 === 1 && all[index - 1].toLowerCase() === "x-spek-event-id");
    const event = eventHeaders.length === 1 ? z.string().uuid().safeParse(eventHeaders[0]) : null;
    if (!event?.success) { res.status(400).json({ error: "One UUID event id is required" }); return; }
    const sanitized = (() => { try { return sanitizeSyntheticWebhook(req.body); } catch { return null; } })();
    if (!sanitized) { res.status(400).json({ error: "Payload is outside the synthetic allowlist" }); return; }
    const auth = parseIngestionAuthorization(req.get("authorization") ?? null);
    if (!auth) { res.status(401).json({ error: "Unauthorized" }); return; }
    try {
      const result = await acceptSyntheticWebhook(db, auth.token, event.data, sanitized);
      res.status(result.created ? 202 : 200).json({ receiptId: result.id, duplicate: !result.created,
        accepted: true, meaning: "Stored for asynchronous schema validation; no business processing performed" });
    } catch (error) {
      const status = error instanceof IngestionUnauthorizedError ? 401 : error instanceof WebhookConflictError ? 409 : 503;
      res.status(status).json({ error: status === 401 ? "Unauthorized" : status === 409 ? "Event conflicts with an accepted receipt" : "Storage unavailable; acceptance not confirmed" });
    }
  });
  const parserError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    void _next;
    const status = error && typeof error === "object" && "status" in error ? error.status : null;
    res.status(status === 413 ? 413 : status === 415 ? 415 : 400).json({ error: "Invalid or oversized JSON request" });
  };
  app.use(parserError);
  return app;
}
