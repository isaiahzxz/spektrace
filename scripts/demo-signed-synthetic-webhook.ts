import "dotenv/config";
import { readFile } from "node:fs/promises";
import { getPrisma } from "@/lib/db";
import { createSignedSyntheticWebhookApp } from "@/server/webhooks/signed-synthetic-express-app";

async function main() {
  if (process.env.SPEKTRACE_SYNTHETIC_WEBHOOK_ENABLED !== "true" || !process.env.SPEKTRACE_SYNTHETIC_SIGNING_KEYS_FILE)
    throw new Error("Explicit synthetic enable flag and private signing key file required");
  const keys = JSON.parse(await readFile(process.env.SPEKTRACE_SYNTHETIC_SIGNING_KEYS_FILE, "utf8"));
  const db = getPrisma();
  const server = createSignedSyntheticWebhookApp(db, keys).listen(3002, "127.0.0.1", () => {
    console.log("Synthetic signing only: http://127.0.0.1:3002/synthetic/signed-webhooks/payments");
    console.log("Configured key possession only; no real provider or business processing. Unsigned endpoint is not mounted.");
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
    server.close(() => { void db.$disconnect().then(() => process.exit(0)); });
  });
}
main().catch(() => { console.error("Synthetic signing startup failed; configuration values withheld."); process.exitCode = 1; });
