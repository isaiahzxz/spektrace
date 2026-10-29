import "dotenv/config";
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { getPrisma } from "@/lib/db";
import { stripeTestEndpointConfigSchema } from "@/server/webhooks/stripe-snapshot-verification";
import { createStripeTestExpressApp } from "@/server/webhooks/stripe-test-express-app";

async function main() {
  const file = process.env.SPEKTRACE_STRIPE_TEST_CONFIG_FILE;
  if (process.env.NODE_ENV === "production" || process.env.SPEKTRACE_STRIPE_TEST_ENABLED !== "true" || !file)
    throw new Error("Local test enable flag and private configuration file required");
  if ((await stat(file)).size > 8_192) throw new Error("Configuration too large");
  const config = z.object({ verification: stripeTestEndpointConfigSchema, ingestionToken: z.string().max(256) }).strict()
    .parse(JSON.parse(await readFile(file, "utf8")));
  const db = getPrisma();
  const server = createStripeTestExpressApp(db, config.verification, config.ingestionToken).listen(3004, "127.0.0.1", () => {
    console.log("Local test-mode Stripe receiver: http://127.0.0.1:3004/stripe/test/webhooks");
    console.log("Structural projection only. Contract checks incomplete. No payment or business processing.");
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  server.on("error", () => { console.error("Local Stripe receiver failed; configuration withheld."); void db.$disconnect(); process.exitCode = 1; });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
    server.close(() => { void db.$disconnect().then(() => process.exit(0)); });
    server.closeIdleConnections();
  });
}
main().catch(() => { console.error("Local Stripe startup rejected; configuration values withheld."); process.exitCode = 1; });
