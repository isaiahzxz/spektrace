import express, { type ErrorRequestHandler } from "express";
import type { PrismaClient } from "@/generated/prisma/client";
import { parseIngestionAuthorization } from "@/lib/ingestion/credential-token";
import { authenticateIngestionToken, IngestionUnauthorizedError } from "@/server/services/ingestion-credentials";
import { acceptSyntheticWebhook, WebhookConflictError, WebhookRevisionUnavailableError } from "@/server/services/accept-synthetic-webhook";
import { createSyntheticSignatureVerifier, signingProofContext, singleWebhookHeader, SIGNED_WEBHOOK_PATH,
  WebhookSignatureError, WebhookPayloadError, type SyntheticSigningKey } from "@/server/webhooks/synthetic-signature";

export function createSignedSyntheticWebhookApp(db: PrismaClient, keys: SyntheticSigningKey[]) {
  const verify = createSyntheticSignatureVerifier(keys);
  const app = express(); app.disable("x-powered-by");
  app.use(async (req, res, next) => {
    if (req.method !== "POST" || req.originalUrl !== SIGNED_WEBHOOK_PATH) { res.status(404).json({ error: "Not found" }); return; }
    const auth = parseIngestionAuthorization(singleWebhookHeader(req.rawHeaders, "authorization"));
    if (!auth) { res.status(401).json({ error: "Unauthorized" }); return; }
    try { await authenticateIngestionToken(db, auth.token); }
    catch (error) { res.status(error instanceof IngestionUnauthorizedError ? 401 : 503).json({ error: error instanceof IngestionUnauthorizedError ? "Unauthorized" : "Storage unavailable" }); return; }
    const contentType = singleWebhookHeader(req.rawHeaders, "content-type");
    if (!contentType || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(contentType) ||
      req.rawHeaders.some((value, index) => index % 2 === 0 && value.toLowerCase() === "content-encoding")) {
      res.status(415).json({ error: "Uncompressed UTF-8 JSON required" }); return;
    }
    next();
  });
  app.post(SIGNED_WEBHOOK_PATH, express.raw({ type: "application/json", limit: 4096, inflate: false }), async (req, res) => {
    try {
      const proof = verify(req.rawHeaders, req.body, req.method, req.originalUrl);
      const context = signingProofContext(proof);
      const auth = parseIngestionAuthorization(singleWebhookHeader(req.rawHeaders, "authorization"));
      if (!auth) throw new IngestionUnauthorizedError();
      const result = await acceptSyntheticWebhook(db, auth.token, context.eventId, context.body, proof);
      res.status(result.created ? 202 : 200).json({ receiptId: result.id, duplicate: !result.created, accepted: true,
        meaning: "Stored for asynchronous schema validation; no business processing performed" });
    } catch (error) {
      const status = error instanceof IngestionUnauthorizedError || error instanceof WebhookSignatureError ? 401 :
        error instanceof WebhookPayloadError ? 400 : error instanceof WebhookConflictError ? 409 : error instanceof WebhookRevisionUnavailableError ? 422 : 503;
      res.status(status).json({ error: status === 401 ? "Unauthorized" : status === 400 ? "Payload is outside the synthetic allowlist" :
        status === 409 ? "Event conflicts with an accepted receipt" : status === 422 ? "Configured revision unavailable; acceptance not confirmed" : "Storage unavailable; acceptance not confirmed" });
    } finally { if (Buffer.isBuffer(req.body)) req.body.fill(0); req.body = undefined; }
  });
  const parserError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    void _next;
    const status = error && typeof error === "object" && "status" in error ? error.status : null;
    res.status(status === 413 ? 413 : 400).json({ error: "Invalid or oversized JSON request" });
  };
  app.use(parserError); return app;
}
