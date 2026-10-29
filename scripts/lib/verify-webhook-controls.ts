import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile, rm, rmdir } from "node:fs/promises";
import path from "node:path";

export async function proveWebhookControls(env: NodeJS.ProcessEnv, includeView = false, includeSigning = false, includeGrouping = false, includeGroupsView = false, includeRevision = false) {
  const root = process.cwd();
  const revisionControls = [
    { kind: "revision-scope", target: 'id: binding.apiSpecId, workspaceId: auth.workspaceId,', replacement: 'id: binding.apiSpecId, workspaceId: undefined,',
      title: "rejects missing, wrong-scope and wrong-hash configured targets", marker: "configured target isolation" },
    { kind: "revision-hash", target: 'environment: "default", sourceSha256: binding.sourceSha256', replacement: 'environment: "default", sourceSha256: undefined',
      title: "rejects missing, wrong-scope and wrong-hash configured targets", marker: "configured target isolation" },
    { kind: "revision-active", target: 'const binding = signed?.revisionBinding;\n    const spec = binding ?', replacement: 'const binding = undefined;\n    const spec = binding ?',
      title: "uses the configured inactive revision", marker: "to be" },
    { kind: "revision-retry", target: 'oldPin.data.apiSpecId !== binding.apiSpecId || oldPin.data.sourceSha256 !== binding.sourceSha256', replacement: 'false',
      title: "deduplicates configured retries and conflicts", marker: "409" },
  ];
  const controls = ["privacy", "atomicity", ...(includeView ? ["view-scope", "view-payload"] : []), ...(includeSigning ? ["signature"] : []), ...(includeGrouping ? ["grouping-sender"] : []), ...(includeGroupsView ? ["groups-list-scope", "groups-scope", "groups-private"] : []), ...(includeRevision ? revisionControls.map((control) => control.kind) : [])];
  for (const kind of controls) {
    console.log(`Checking isolated webhook ${kind} control.`);
    const dir = path.join(root, "work", `historical-guard-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    const copy = path.join(dir, "control.ts"); const config = path.join(dir, "vitest.config.ts"); const report = path.join(dir, "report.json");
    const view = kind.startsWith("view-");
    const revision = revisionControls.find((control) => control.kind === kind);
    const sourceModule = kind.startsWith("groups-") ? "src/server/dashboard/webhook-groups.ts" : kind === "grouping-sender" ? "src/server/services/group-webhook-drift.ts" : view ? "src/server/dashboard/webhook-receipts.ts" : kind === "signature" ? "src/server/webhooks/synthetic-signature.ts" : kind === "privacy" ? "src/lib/ingestion/synthetic-webhook.ts" : "src/server/services/accept-synthetic-webhook.ts";
    const source = (await readFile(path.join(root, sourceModule), "utf8")).replaceAll("\r\n", "\n");
    const target = revision?.target ?? (kind === "groups-list-scope" ? "const where = scope(workspaceId, filters);" : kind === "groups-scope" ? "where: { ...scope(workspaceId, filters), id: groupId }" : kind === "groups-private" ? "id: true, receivedAt: true, apiKey: true" : kind === "grouping-sender" ? "findFirst({ where: dimensions })" : kind === "signature" ? 'if (!timingSafeEqual(expected, Buffer.from(signature.slice(3), "hex"))) throw new WebhookSignatureError();' : kind === "view-scope" ? "where: { ...scope(workspaceId, filters), id: receiptId }" :
      kind === "view-payload" ? "payload: protectedBody.success ? JSON.stringify(protectedBody.data.payload, null, 2) : null," :
      kind === "privacy" ? 'payload: body.amount === undefined ? {} : { amount: body.amount },' :
      '    await tx.outboxEvent.create({ data: { workspaceId: auth.workspaceId, webhookReceiptId: receipt.id,\n      dedupeKey: `webhook-validation:${receipt.id}`, eventType: "WEBHOOK_VALIDATION_REQUESTED" } });');
    if (source.split(target).length !== 2) throw new Error("Webhook control target mismatch");
    const title = revision?.title ?? (kind === "groups-scope" || kind === "groups-list-scope" ? "does not expose another workspace group" : kind === "groups-private" ? "bounds member pages and exports metadata only" : kind === "grouping-sender" ? "keeps a different verified sender out" : kind === "signature" ? "rejects byte, event, timestamp and key tampering" : kind === "view-scope" ? "does not expose another workspace receipt" : kind === "view-payload" ? "paginates in stable receipt order" :
      kind === "privacy" ? "retains only the bounded fixture amount" : "rolls back receipt on outbox failure");
    const replacement = revision?.replacement ?? (kind === "groups-list-scope" ? "const where = { groupingVersion: 1 };" : kind === "groups-scope" ? "where: { id: groupId }" : kind === "groups-private" ? "sanitizedPayload: true, id: true, receivedAt: true, apiKey: true" : kind === "grouping-sender" ? "findFirst({ where: { ...dimensions, senderId: undefined } })" : kind === "signature" ? "void expected; void timingSafeEqual;" : kind === "view-scope" ? "where: { id: receiptId }" : kind === "view-payload" ? "payload: JSON.stringify(row.sanitizedPayload)," : kind === "privacy" ? "payload: body," : "");
    const marker = revision?.marker ?? (kind === "groups-list-scope" ? "to deeply equal" : kind === "groups-scope" ? "to be null" : kind === "groups-private" ? "unique-private" : kind === "grouping-sender" ? "sender separation" : kind === "signature" ? "401" : view ? "to be null" : kind === "privacy" ? "unique-private" : "503");
    try {
      let changed = source.replace(target, replacement);
      if (kind === "groups-private") {
        const spread = "memberships.map(({ receipt }) => ({ id: receipt.id";
        if (changed.split(spread).length !== 2) throw new Error("Group privacy control target mismatch");
        changed = changed.replace(spread, "memberships.map(({ receipt }) => ({ ...receipt, id: receipt.id");
      }
      await writeFile(copy, changed);
      await writeFile(config, `import { defineConfig } from "vitest/config"; export default defineConfig(${JSON.stringify({
        test: { environment: "node", setupFiles: [path.join(root, "tests/setup-env.ts")], fileParallelism: false },
        resolve: { alias: [
          { find: `@/${sourceModule.replace(/^src\//, "").replace(/\.ts$/, "")}`, replacement: copy },
          { find: "@", replacement: path.join(root, "src") },
          { find: "server-only", replacement: path.join(root, "tests/stubs/server-only.ts") },
        ] },
      })});`);
      const result = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", revision ? "tests/integration/webhook-configured-revision.test.ts" : kind.startsWith("groups-") ? "tests/integration/webhook-groups-view.test.ts" : kind === "grouping-sender" ? "tests/integration/webhook-drift-grouping.test.ts" : kind === "signature" ? "tests/integration/synthetic-webhook-signing.test.ts" : view ? "tests/integration/webhook-receipts-view.test.ts" : kind === "privacy" ? "tests/unit/synthetic-webhook.test.ts" : "tests/integration/synthetic-webhook.test.ts",
        "--config", config, "-t", title, "--reporter=json", "--outputFile", report], { env, windowsHide: true, encoding: "utf8", timeout: 60_000 });
      const parsed = JSON.parse(await readFile(report, "utf8")) as { numFailedTests: number; testResults: { assertionResults: { title: string; status: string; failureMessages: string[] }[] }[] };
      const failed = parsed.testResults.flatMap((suite) => suite.assertionResults).filter((test) => test.status === "failed");
      if (result.status !== 1 || parsed.numFailedTests !== 1 || failed.length !== 1 || !failed[0].title.startsWith(title) ||
        !failed[0].failureMessages.some((message) => message.includes(marker)))
        { console.error(JSON.stringify({ control: kind, exit: result.status, failedCount: parsed.numFailedTests, expectedTitle: failed[0]?.title.startsWith(title),
          expectedMarker: failed[0]?.failureMessages.some((message) => message.includes(marker)) }));
          throw new Error("Webhook control did not fail at its intended assertion"); }
      console.log(`Webhook ${kind} control caught the intentional unsafe source copy. Application source unchanged.`);
    } finally {
      for (const file of [copy, config, report]) await rm(file, { force: true });
      await rmdir(dir);
    }
  }
}
