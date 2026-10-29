import express, { type ErrorRequestHandler } from "express";
import type { PrismaClient } from "@/generated/prisma/client";
import { parseIngestionToken } from "@/lib/ingestion/credential-token";
import { createStripeTestSnapshotVerifier, StripeVerificationError, STRIPE_SNAPSHOT_LIMITS, type StripeTestEndpointConfig } from "@/server/webhooks/stripe-snapshot-verification";
import { acceptStripeWebhook, StripeReceiptConflictError } from "@/server/services/accept-stripe-webhook";
import { IngestionUnauthorizedError } from "@/server/services/ingestion-credentials";

export const STRIPE_TEST_PATH = "/stripe/test/webhooks";
export function createStripeTestExpressApp(db: PrismaClient, config: StripeTestEndpointConfig, serverToken: string) {
  if (!parseIngestionToken(serverToken)) throw new IngestionUnauthorizedError();
  const verify = createStripeTestSnapshotVerifier(config), app = express(); app.disable("x-powered-by");
  app.use((req, res, next) => {
    if (req.method !== "POST" || req.originalUrl !== STRIPE_TEST_PATH) { res.status(404).json({ error: "Not found" }); return; }
    const types = req.rawHeaders.filter((_value, i, all) => i % 2 === 1 && all[i - 1].toLowerCase() === "content-type");
    if (types.length !== 1 || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(types[0]) ||
      req.rawHeaders.some((value, i) => i % 2 === 0 && value.toLowerCase() === "content-encoding")) {
      res.status(415).json({ error: "Uncompressed UTF-8 JSON required" }); return;
    }
    next();
  });
  app.post(STRIPE_TEST_PATH, express.raw({ type: "application/json", limit: STRIPE_SNAPSHOT_LIMITS.bodyBytes, inflate: false }), async (req, res) => {
    try {
      const proof = verify(req.rawHeaders, req.body);
      const result = await acceptStripeWebhook(db, serverToken, proof);
      res.status(result.created ? 202 : 200).json({ receiptId: result.id, duplicate: !result.created, accepted: true,
        meaning: "Protected shape stored for asynchronous checks; business processing is not confirmed" });
    } catch (error) {
      const status = error instanceof StripeReceiptConflictError ? 409 : error instanceof IngestionUnauthorizedError ? 401 :
        error instanceof StripeVerificationError ? 400 : 503;
      res.status(status).json({ error: status === 409 ? "Event conflicts with retained evidence" : status === 401 ? "Unauthorized integration" :
        status === 400 ? "Stripe test event verification rejected" : "Storage unavailable; acceptance not confirmed" });
    } finally { if (Buffer.isBuffer(req.body)) req.body.fill(0); req.body = undefined; }
  });
  const parserError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    void _next; const oversized = error && typeof error === "object" && "status" in error && error.status === 413;
    res.status(oversized ? 413 : 400).json({ error: "Invalid or oversized request" });
  };
  app.use(parserError); return app;
}
