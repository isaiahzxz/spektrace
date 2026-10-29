import "dotenv/config";
import { getPrisma } from "@/lib/db";
import { createSyntheticWebhookApp } from "@/server/webhooks/synthetic-express-app";

if (process.env.SPEKTRACE_SYNTHETIC_WEBHOOK_ENABLED !== "true") throw new Error("Enable the synthetic webhook demo explicitly before starting");
const db = getPrisma();
const server = createSyntheticWebhookApp(db).listen(3002, "127.0.0.1", () => {
  console.log("Synthetic webhook endpoint: http://127.0.0.1:3002/synthetic/webhooks/payments");
  console.log("Validation-only fixture service synthetic-webhook-payments/default; no payment processing.");
});
server.requestTimeout = 10_000;
server.headersTimeout = 10_000;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  server.close(() => { void db.$disconnect().then(() => process.exit(0)); });
});
