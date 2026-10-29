import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createStripeTestSnapshotVerifier, readVerifiedStripeSnapshotMetadata, StripeVerificationError,
  type StripeTestEndpointConfig } from "../src/server/webhooks/stripe-snapshot-verification";

const root = path.resolve(__dirname, "..");
async function guardControls(): Promise<string[]> {
  const modulePath = "src/server/webhooks/stripe-snapshot-verification.ts";
  const source = (await readFile(path.join(root, modulePath), "utf8")).replaceAll("\r\n", "\n");
  const controls = [
    { name: "signature-bypass", target: 'if (!matched) throw new StripeVerificationError("SIGNATURE_INVALID");',
      replacement: "matched ??= secrets[0];", title: "preserves Unicode and whitespace", marker: "StripeVerificationError" },
    { name: "live-and-connect-bypass", target: 'if (event.livemode || event.account != null || event.context != null) throw new StripeVerificationError("UNSUPPORTED_SCOPE");',
      replacement: "void event.livemode;", title: "rejects live-mode and Connect scope", marker: "StripeVerificationError" },
    { name: "raw-payload-leak", target: 'reportedApiVersion: event.api_version ?? null, livemode: false, signatureTimestamp: header.timestamp,',
      replacement: 'rawPayload: rawBody.toString("utf8"), reportedApiVersion: event.api_version ?? null, livemode: false, signatureTimestamp: header.timestamp,',
      title: "verifies independent signed fixtures and exposes only bounded metadata", marker: "private-" },
    { name: "hidden-byte-normalization", target: 'fatal: true, ignoreBOM: true', replacement: 'fatal: true',
      title: "rejects an added UTF-8 byte-order mark", marker: "StripeVerificationError" },
  ];
  const caught: string[] = [];
  for (const control of controls) {
    assert.equal(source.split(control.target).length, 2, "Guard source target must be unique");
    const directory = path.join(root, "work", `stripe-guard-${randomUUID()}`); await mkdir(directory, { recursive: true });
    const copy = path.join(directory, "control.ts"), config = path.join(directory, "vitest.config.ts"), report = path.join(directory, "results.json");
    try {
      await writeFile(copy, source.replace(control.target, control.replacement));
      await writeFile(config, `import { defineConfig } from "vitest/config"; export default defineConfig(${JSON.stringify({
        test: { environment: "node", fileParallelism: false }, resolve: { alias: [
          { find: "@/server/webhooks/stripe-snapshot-verification", replacement: copy },
          { find: "@", replacement: path.join(root, "src") },
        ] },
      })});`);
      const run = spawnSync(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run",
        "tests/unit/stripe-snapshot-verification.test.ts", "--config", config, "-t", control.title, "--reporter=json", "--outputFile", report],
      { cwd: root, windowsHide: true, encoding: "utf8", timeout: 60_000 });
      const result = JSON.parse(await readFile(report, "utf8")) as { numFailedTests: number; testResults: {
        assertionResults: { title: string; status: string; failureMessages: string[] }[] }[] };
      const failures = result.testResults.flatMap((suite) => suite.assertionResults).filter((test) => test.status === "failed");
      assert.equal(run.status, 1); assert.equal(result.numFailedTests, 1); assert.equal(failures.length, 1);
      assert.ok(failures[0].title.startsWith(control.title)); assert.ok(failures[0].failureMessages.some((message) => message.includes(control.marker)));
      caught.push(control.name); console.log(`Stripe guard caught: ${control.name}`);
    } finally {
      for (const file of [copy, config, report]) await rm(file, { force: true });
      await rmdir(directory);
    }
  }
  return caught;
}

async function main() {
  const output = path.join(root, "work/stripe-verification"); await mkdir(output, { recursive: true });
  const resultPath = path.join(output, "results.json"); await rm(resultPath, { force: true });
  const tests = spawnSync(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run", "tests/unit/stripe-snapshot-verification.test.ts"],
    { cwd: root, windowsHide: true, stdio: "inherit", timeout: 60_000 });
  assert.equal(tests.status, 0, "Stripe boundary unit tests must pass");
  const controls = await guardControls();
  const config: StripeTestEndpointConfig = { workspaceId: randomUUID(), integrationId: randomUUID(), mode: "test", secrets: [
    { id: randomUUID(), value: `whsec_${randomBytes(32).toString("hex")}`, expiresAt: new Date(Date.now() + 3600_000).toISOString() },
  ] };
  const verify = createStripeTestSnapshotVerifier(config);
  const event = { id: `evt_${randomUUID().replaceAll("-", "")}`, object: "event", type: "payment_intent.payment_failed",
    created: Math.floor(Date.now() / 1000) - 86_400, api_version: "2024-06-20", livemode: false,
    data: { object: { object: "payment_intent", receipt_email: `private-${randomUUID()}@example.test` } } };
  const bytes = Buffer.from(JSON.stringify(event));
  function sign(body: Buffer, seconds = Math.floor(Date.now() / 1000), secret = config.secrets[0].value) {
    const digest = createHmac("sha256", secret).update(`${seconds}.`).update(body).digest("hex");
    return ["Stripe-Signature", `t=${seconds},v1=${digest}`];
  }
  const rows: { name: string; expected: string; observed: string }[] = [];
  function check(name: string, expected: string, headers: string[], body: Buffer) {
    let observed: string;
    try { const metadata = readVerifiedStripeSnapshotMetadata(verify(headers, body)); observed = `VERIFIED:${metadata.eventType}`; }
    catch (error) { if (!(error instanceof StripeVerificationError)) throw new Error("Unexpected boundary failure"); observed = error.code; }
    rows.push({ name, expected, observed }); assert.equal(observed, expected, name);
  }
  check("Valid locally signed test snapshot", "VERIFIED:payment_intent.payment_failed", sign(bytes), bytes);
  check("Byte changed after signing", "SIGNATURE_INVALID", sign(bytes), Buffer.concat([bytes, Buffer.from(" ")]));
  check("Added byte-order mark", "INVALID_ENVELOPE", sign(bytes), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]));
  check("Wrong endpoint secret", "SIGNATURE_INVALID", sign(bytes, undefined, `whsec_${randomBytes(32).toString("hex")}`), bytes);
  check("Stale signature", "TIMESTAMP_OUT_OF_RANGE", sign(bytes, Math.floor(Date.now() / 1000) - 301), bytes);
  check("Future signature", "TIMESTAMP_OUT_OF_RANGE", sign(bytes, Math.floor(Date.now() / 1000) + 31), bytes);
  check("Duplicate signature headers", "INVALID_HEADERS", [...sign(bytes), ...sign(bytes)], bytes);
  const malformed = Buffer.from('{"invalid":'); check("Signed malformed JSON", "INVALID_ENVELOPE", sign(malformed), malformed);
  for (const [name, change, expected] of [
    ["Live-mode event", { livemode: true }, "UNSUPPORTED_SCOPE"],
    ["Connect event", { account: "acct_synthetic" }, "UNSUPPORTED_SCOPE"],
    ["Thin event", { object: "v2.core.event" }, "INVALID_ENVELOPE"],
    ["Unsupported event type", { type: "payment_intent.updated" }, "UNSUPPORTED_EVENT"],
    ["Passing snapshot type", { type: "payment_intent.succeeded" }, "VERIFIED:payment_intent.succeeded"],
  ] as const) { const body = Buffer.from(JSON.stringify({ ...event, ...change })); check(name, expected, sign(body), body); }
  const sample = readVerifiedStripeSnapshotMetadata(verify(sign(bytes), bytes));
  const report = { version: 1, syntheticOnly: true, verificationBoundaryOnly: true, rows, controls, metadataSample: sample,
    executionPassed: true, humanReviewComplete: false,
    databaseTouched: false, providerRequests: 0, deliveryAcknowledged: false, payloadStored: false,
    limits: ["Test-mode account-scoped PaymentIntent snapshot envelopes only", "No live Stripe delivery or CLI observation",
      "No durable dedupe or receipts; a fresh retry can verify again", "No payload/resource identity in metadata; full schema checking is not implemented",
      "API version is reported metadata, not a contract or deployment revision"] };
  const serialized = JSON.stringify(report, null, 2);
  assert.ok(!serialized.includes(config.secrets[0].value)); assert.ok(!serialized.includes(event.data.object.receipt_email));
  await writeFile(resultPath, serialized);
  console.log(`Stripe verification checkpoint: ${rows.length} observations matched; ${controls.length} unsafe-source controls caught. No DB, provider request or acknowledgment.`);
}
void main().catch(() => { console.error("Stripe verification checkpoint failed; raw inputs and secrets withheld."); process.exitCode = 1; });
