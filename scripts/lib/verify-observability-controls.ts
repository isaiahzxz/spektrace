import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
export async function proveObservabilityControls(env: NodeJS.ProcessEnv) {
  const root = process.cwd(),
    directory = path.resolve(
      "work/integration-observability",
      `controls-${randomUUID()}`,
    );
  await mkdir(directory, { recursive: true });
  const controls = [
    {
      name: "tenant-read",
      module: "@/server/dashboard/integration-observations",
      source: "src/server/dashboard/integration-observations.ts",
      target: "where: { workspaceId, id },",
      replacement: "where: { id },",
      file: "tests/integration/integration-observability.test.ts",
      title:
        "withholds cross-workspace reads and inconsistent detector evidence",
      failure: "to be null",
    },
    {
      name: "baseline-pin",
      module: "@/server/integration-observations/ingest",
      source: "src/server/integration-observations/ingest.ts",
      target: "baselineId: baseline?.id,",
      replacement: "baselineId: null,",
      file: "tests/integration/integration-observability.test.ts",
      title: "detects payment and CRM response changes at HTTP 200",
      failure: "baselineId",
    },
    {
      name: "type-drift",
      module: "@/lib/integration-observations/detector",
      source: "src/lib/integration-observations/detector.ts",
      target: "expected === actual ||",
      replacement: "true ||",
      file: "tests/unit/integration-observations.test.ts",
      title: "distinguishes observed response drift",
      failure: "DRIFT",
    },
  ];
  controls.push({
    name: "fan-out-cap",
    module: "@/server/integration-observations/process",
    source: "src/server/integration-observations/process.ts",
    target: "if (existing.length >= 100)",
    replacement: "if (false)",
    file: "tests/integration/integration-observability.test.ts",
    title:
      "enforces the link fan-out cap across late calls and outcome processing",
    failure: "100",
  });
  const result: { control: string; detected: boolean }[] = [];
  for (const control of controls) {
    let source = (await readFile(control.source, "utf8")).replaceAll(
      "\r\n",
      "\n",
    );
    if (source.split(control.target).length !== 2)
      throw Error("Negative control target changed");
    source = source
      .replace(control.target, control.replacement)
      .replace('"./contract"', '"@/lib/integration-observations/contract"');
    const copy = path.join(directory, control.name + ".ts"),
      config = path.join(directory, control.name + ".config.ts"),
      report = path.join(directory, control.name + ".json");
    await writeFile(copy, source);
    await writeFile(
      config,
      `import {defineConfig} from 'vitest/config';export default defineConfig(${JSON.stringify(
        {
          test: {
            environment: "node",
            include: [control.file],
            exclude: ["work/**", "node_modules/**"],
            setupFiles: [path.join(root, "tests/setup-env.ts")],
            fileParallelism: false,
          },
          resolve: {
            alias: [
              { find: control.module, replacement: copy },
              { find: "@", replacement: path.join(root, "src") },
              {
                find: "server-only",
                replacement: path.join(root, "tests/stubs/server-only.ts"),
              },
            ],
          },
        },
      )});`,
    );
    const output = spawnSync(
      process.execPath,
      [
        "node_modules/vitest/vitest.mjs",
        "run",
        control.file,
        "--config",
        config,
        "-t",
        control.title,
        "--reporter=json",
        "--outputFile",
        report,
      ],
      {
        windowsHide: true,
        timeout: 30000,
        encoding: "utf8",
        env: { ...env, SPEKTRACE_OBSERVABILITY_REPORT_DIR: undefined },
      },
    );
    await writeFile(
      path.join(directory, control.name + ".stdout.log"),
      output.stdout ?? "",
    );
    await writeFile(
      path.join(directory, control.name + ".stderr.log"),
      output.stderr ?? "",
    );
    const parsed = JSON.parse(await readFile(report, "utf8")) as {
      numFailedTests: number;
      testResults: {
        assertionResults: {
          status: string;
          title: string;
          failureMessages: string[];
        }[];
      }[];
    };
    const failures = parsed.testResults
      .flatMap((suite) => suite.assertionResults)
      .filter((item) => item.status === "failed");
    if (
      output.status !== 1 ||
      parsed.numFailedTests !== 1 ||
      failures.length !== 1 ||
      !failures[0].title.startsWith(control.title) ||
      !failures[0].failureMessages.some((message) =>
        message.includes(control.failure),
      )
    )
      throw Error("Negative control failed outside intended assertion");
    result.push({ control: control.name, detected: true });
  }
  const outputDirectory = env.SPEKTRACE_OBSERVABILITY_REPORT_DIR ?? directory;
  await writeFile(
    path.join(outputDirectory, "negative-controls.json"),
    JSON.stringify(
      { applicationSourceChanged: false, controls: result },
      null,
      2,
    ),
  );
  console.log(
    "Four isolated unsafe source copies failed their expected tenant/baseline/drift/link-limit assertions. Application source unchanged.",
  );
}
