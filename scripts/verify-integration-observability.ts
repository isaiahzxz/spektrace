import "dotenv/config";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
const expected = [
  "200-drift-payments",
  "200-drift-crm",
  "request-mismatch",
  "timeout-no-drift",
  "drift-no-failure",
  "delayed-outcome",
  "dedupe-retries",
  "privacy-isolation",
  "deterministic-ai",
  "coverage-unmatched",
];
async function main() {
  const directory = path.resolve(
    "work/integration-observability",
    randomUUID(),
  );
  await mkdir(directory, { recursive: true });
  const out = await open(path.join(directory, "stdout.log"), "wx"),
    err = await open(path.join(directory, "stderr.log"), "wx");
  let exitCode: number | null = null;
  try {
    exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/verify-historical-revisions.ts",
          "--observability",
          ...process.argv.slice(2),
        ],
        {
          windowsHide: true,
          stdio: ["ignore", out.fd, err.fd],
          env: {
            ...process.env,
            SPEKTRACE_OBSERVABILITY_REPORT_DIR: directory,
          },
        },
      );
      child.once("error", reject);
      child.once("exit", resolve);
    });
  } catch {
    exitCode=null;
  } finally {
    await out.close();
    await err.close();
  }
  let cases: { id: string; status: string; evidence: unknown }[] = [];
  try {
    cases = JSON.parse(
      await readFile(path.join(directory, "cases.json"), "utf8"),
    ).cases;
  } catch {}
  const acceptance = expected.map(
    (id) =>
      cases.find((item) => item.id === id) ?? {
        id,
        status: "not_evaluated",
        evidence: null,
      },
  );
  const report = {
    version: 1,
    syntheticOnly: true,
    realIntegrations: [],
    execution: { exitCode, succeeded: exitCode === 0 },
    acceptance,
    automatedAcceptanceComplete:
      exitCode === 0 && acceptance.every((item) => item.status === "matched"),
    humanReview: "pending",
    aiInvoked: false,
    logs: { stdout: "stdout.log", stderr: "stderr.log" },
    limitations: [
      "Selected-field presence/types only; no complete API or traffic coverage",
      "Correlation is not causation",
      "No production load benchmark or retention purge",
    ],
  };
  await writeFile(
    path.join(directory, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      report: path.join(directory, "report.json"),
      automatedAcceptanceComplete: report.automatedAcceptanceComplete,
      humanReview: report.humanReview,
    }),
  );
  process.exitCode = report.automatedAcceptanceComplete ? 0 : 1;
}
main().catch(() => {
  console.error(
    "Observability verification failed; inspect the separate logs. Connection details withheld.",
  );
  process.exitCode = 1;
});
