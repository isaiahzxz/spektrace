import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

export async function proveStripeViewControls(env: NodeJS.ProcessEnv) {
  const root = process.cwd(), source = (await readFile("src/server/dashboard/stripe-receipts.ts", "utf8")).replaceAll("\r\n", "\n");
  const controls = [
    { name: "list-workspace-isolation", target: "const where = scope(workspaceId, filters);", replacement: "const where = {};",
      title: "isolates list/detail by workspace", marker: "to deeply equal" },
    { name: "detail-workspace-isolation", target: "where: { ...scope(workspaceId, filters), id: receiptId },", replacement: "where: { id: receiptId },",
      title: "isolates list/detail by workspace", marker: "to be null" },
    { name: "unsupported-shape-withholding", target: "return { ...summary, state:", replacement: "return { unsafeStoredShape: row.protectedShape, ...summary, state:",
      title: "withholds unknown/malformed shapes", marker: "never-display-" },
  ];
  for (const control of controls) {
    assert.equal(source.split(control.target).length, 2, "Control target must be unique");
    const directory = path.join(root, "work", `stripe-view-control-${randomUUID()}`); await mkdir(directory, { recursive: true });
    const copy = path.join(directory, "control.ts"), config = path.join(directory, "vitest.config.ts"), report = path.join(directory, "result.json");
    try {
      await writeFile(copy, source.replace(control.target, control.replacement));
      await writeFile(config, `import { defineConfig } from "vitest/config"; export default defineConfig(${JSON.stringify({
        test: { environment: "node", setupFiles: [path.join(root, "tests/setup-env.ts")], fileParallelism: false },
        resolve: { alias: [
          { find: "@/server/dashboard/stripe-receipts", replacement: copy },
          { find: "@", replacement: path.join(root, "src") },
          { find: "server-only", replacement: path.join(root, "tests/stubs/server-only.ts") },
        ] },
      })});`);
      const run = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/integration/stripe-receipts-view.test.ts",
        "--config", config, "-t", control.title, "--reporter=json", "--outputFile", report], { cwd: root, env, windowsHide: true, encoding: "utf8", timeout: 60_000 });
      const result = JSON.parse(await readFile(report, "utf8")) as { numFailedTests: number; testResults: { assertionResults: { status: string; title: string; failureMessages: string[] }[] }[] };
      const failures = result.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === "failed");
      assert.equal(run.status, 1); assert.equal(result.numFailedTests, 1); assert.equal(failures.length, 1);
      assert.ok(failures[0].title.startsWith(control.title)); assert.ok(failures[0].failureMessages.some(message => message.includes(control.marker)));
      console.log(`Stripe view control caught: ${control.name}`);
    } finally { for (const file of [copy, config, report]) await rm(file, { force: true }); await rmdir(directory); }
  }
}
