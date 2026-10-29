import "dotenv/config";
import { proveObservabilityControls } from "./lib/verify-observability-controls";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Client } from "pg";
import { mkdir, readFile, writeFile, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { requireTestDatabaseUrl } from "@/lib/env";
import { deployMigrationsForUrl } from "@/lib/deploy-migrations";
import { proveStripeViewControls } from "./lib/verify-stripe-view-controls";
import { proveWebhookControls } from "./lib/verify-webhook-controls";

async function installSenderPackage(root: string, directory: string) {
  await mkdir(directory, { recursive: true });
  const artifactDir = path.join(root, "work", "express-monitoring");
  await mkdir(artifactDir, { recursive: true });
  const npm =
    process.env.npm_execpath ??
    path.join(
      path.dirname(process.execPath),
      "node_modules/npm/bin/npm-cli.js",
    );
  const packed = spawnSync(
    process.execPath,
    [
      npm,
      "pack",
      "./packages/express-monitoring",
      "--pack-destination",
      artifactDir,
    ],
    {
      cwd: root,
      stdio: "pipe",
      windowsHide: true,
      timeout: 60_000,
    },
  );
  if (packed.status !== 0) throw new Error("Sender package build/pack failed");
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: "synthetic-sender-package-review",
      version: "1.0.0",
      private: true,
    }),
  );
  const installed = spawnSync(
    process.execPath,
    [
      npm,
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--legacy-peer-deps",
      path.join(artifactDir, "spektrace-express-monitoring-0.2.0.tgz"),
    ],
    {
      cwd: directory,
      stdio: "pipe",
      windowsHide: true,
      timeout: 60_000,
    },
  );
  if (installed.status !== 0)
    throw new Error("Offline isolated sender package installation failed");
  const metadata = JSON.parse(
    await readFile(
      path.join(
        directory,
        "node_modules/@spektrace/express-monitoring/package.json",
      ),
      "utf8",
    ),
  );
  if (
    metadata.name !== "@spektrace/express-monitoring" ||
    metadata.version !== "0.2.0"
  )
    throw new Error("Unexpected installed package");
  console.log(
    "Express 0.2.0 packed and installed offline into a disposable consumer; no publish or live-demo change.",
  );
}

async function proveBoundaryGuard(
  env: NodeJS.ProcessEnv,
  kind: "historical" | "sender" | "grouping" | "evidence",
) {
  const root = process.cwd();
  const dir = path.join(root, "work", `historical-guard-${randomUUID()}`);
  const copy = path.join(dir, "incident-submission-control.ts");
  const config = path.join(dir, "vitest.config.ts");
  const report = path.join(dir, "report.json");
  const sender = kind === "sender";
  const grouping = kind === "grouping";
  const evidence = kind === "evidence";
  const sourceFile = evidence
    ? "src/lib/investigation/sender-grouping.ts"
    : grouping
      ? "src/server/services/assign-incident-investigation-group.ts"
      : sender
        ? "src/server/services/sender-identity.ts"
        : "src/server/services/incident-submission.ts";
  const source = (
    await readFile(path.join(root, sourceFile), "utf8")
  ).replaceAll("\r\n", "\n");
  const target = evidence
    ? " || !validEvidence"
    : grouping
      ? "\n            senderGroupingKey: sender.senderGroupingKey,\n"
      : sender
        ? "const claim = rawClaim ? senderReferenceSchema.parse(rawClaim) : null;"
        : "historical ? historical.spec :";
  if (source.split(target).length !== 2)
    throw new Error("Guard control cannot locate the selection branch");
  await mkdir(dir, { recursive: true });
  try {
    const replacement = evidence
      ? ""
      : grouping
        ? "\n"
        : sender
          ? 'const claim = rawClaim ? senderReferenceSchema.parse(rawClaim) : reportedClientRef ? { principalKind: "api_key_id" as const, principalRef: reportedClientRef } : null;'
          : "historical ? (historical.spec ?? await getActiveApiSpec(prisma, workspaceId, input.apiKey, environment)) :";
    await writeFile(copy, source.replace(target, replacement));
    await writeFile(
      config,
      `import { defineConfig } from "vitest/config"; export default defineConfig(${JSON.stringify(
        {
          test: {
            environment: "node",
            setupFiles: [path.join(root, "tests/setup-env.ts")],
            fileParallelism: false,
          },
          resolve: {
            alias: [
              {
                find: evidence
                  ? "@/lib/investigation/sender-grouping"
                  : grouping
                    ? "@/server/services/assign-incident-investigation-group"
                    : sender
                      ? "@/server/services/sender-identity"
                      : "@/server/services/incident-submission",
                replacement: copy,
              },
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
    const title = evidence
      ? "isolates minimal, empty-finding and outcome-inconsistent evidence"
      : grouping
        ? "merges the same sender/revision but separates different senders"
        : sender
          ? "attests only an exact collector binding"
          : "keeps missing coverage unknown";
    const result = spawnSync(
      process.execPath,
      [
        "node_modules/vitest/vitest.mjs",
        "run",
        grouping || evidence
          ? "tests/integration/sender-grouping.test.ts"
          : sender
            ? "tests/integration/sender-identity.test.ts"
            : "tests/integration/historical-revisions.test.ts",
        "--config",
        config,
        "-t",
        title,
        "--reporter=json",
        "--outputFile",
        report,
      ],
      {
        env,
        encoding: "utf8",
        windowsHide: true,
        timeout: 60_000,
      },
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
    const failed = parsed.testResults
      .flatMap((suite) => suite.assertionResults)
      .filter((test) => test.status === "failed");
    if (
      result.status !== 1 ||
      parsed.numFailedTests !== 1 ||
      failed.length !== 1 ||
      !failed[0].title.startsWith(title) ||
      !failed[0].failureMessages.some((message) =>
        message.includes(
          grouping
            ? "not to be"
            : sender || evidence
              ? "to be null"
              : "apiSpecId",
        ),
      )
    )
      throw new Error(
        "Boundary control did not fail at the expected assertion",
      );
    console.log(
      `Guard control: an isolated ${evidence ? "incomplete-evidence-proof" : grouping ? "missing-sender-dimension" : sender ? "header-upgrade" : "unsafe-fallback"} copy failed its expected assertion. Application source unchanged.`,
    );
  } finally {
    for (const file of [copy, config, report]) await rm(file, { force: true });
    await rmdir(dir);
  }
}

async function main() {
  const guardedUrl = requireTestDatabaseUrl();
  const databaseName = `spektrace_test_history_${randomUUID().replaceAll("-", "")}`;
  if (!/^spektrace_test_history_[a-f0-9]{32}$/.test(databaseName))
    throw new Error("Invalid temporary target");
  const admin = new Client({ connectionString: guardedUrl });
  await admin.connect();
  let created = false;
  const root = process.cwd();
  const senderConsumer = process.argv.includes("--sender")
    ? path.join(root, "work", `sender-package-review-${randomUUID()}`)
    : undefined;
  try {
    if (process.argv.includes("--webhook-corpus"))
      await rm(path.join(root, "work/webhook-classification/results.json"), {
        force: true,
      });
    if (senderConsumer) await installSenderPackage(root, senderConsumer);
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const isolated = new URL(guardedUrl);
    isolated.pathname = `/${databaseName}`;
    deployMigrationsForUrl(isolated.toString());
    const env = {
      ...process.env,
      DATABASE_URL: isolated.toString(),
      TEST_DATABASE_URL: isolated.toString(),
      SPEKTRACE_HISTORICAL_VERIFY_DATABASE: databaseName,
      ...(process.argv.includes("--webhook-corpus")
        ? {
            SPEKTRACE_CLASSIFICATION_REPORT_DIR: path.resolve(
              root,
              "work/webhook-classification",
            ),
          }
        : {}),
      ...(senderConsumer
        ? { SPEKTRACE_SENDER_PACKAGE_ROOT: senderConsumer }
        : {}),
      SPEKTRACE_AI_INVESTIGATION_ENABLED: "false",
      SPEKTRACE_PAYLOAD_PROPOSALS_ENABLED: "false",
    };
    if (
      process.argv.includes("--unit") ||
      process.argv.includes("--unit-harness")
    ) {
      const unit = spawnSync(
        process.execPath,
        [
          "node_modules/vitest/vitest.mjs",
          "run",
          process.argv.includes("--unit-harness")
            ? "tests/unit/real-model-verification-harness.test.ts"
            : "tests/unit",
        ],
        {
          stdio: "inherit",
          windowsHide: true,
          timeout: 180_000,
          env: { ...env, DATABASE_URL: process.env.DATABASE_URL },
        },
      );
      if (unit.status !== 0) throw new Error("Unit suite failed");
    }
    // The test guard requires different development/test URLs; the app factory is explicitly bound to TEST_DATABASE_URL.
    const testFiles = [
      ...(process.argv.includes("--mvp-cleanup") ? ["tests/integration/mvp-workstation.test.ts"] : []),
      "tests/integration/historical-revisions.test.ts",
      ...(process.argv.includes("--observability")
        ? ["tests/integration/integration-observability.test.ts"]
        : []),
      ...(process.argv.includes("--stripe-view")
        ? ["tests/integration/stripe-receipts-view.test.ts"]
        : []),
      ...(process.argv.includes("--stripe-receipts")
        ? ["tests/integration/stripe-receipts.test.ts"]
        : []),
      ...(process.argv.includes("--webhook")
        ? ["tests/integration/synthetic-webhook.test.ts"]
        : []),
      ...(process.argv.includes("--webhook-view")
        ? ["tests/integration/webhook-receipts-view.test.ts"]
        : []),
      ...(process.argv.includes("--webhook-signing")
        ? ["tests/integration/synthetic-webhook-signing.test.ts"]
        : []),
      ...(process.argv.includes("--webhook-grouping")
        ? ["tests/integration/webhook-drift-grouping.test.ts"]
        : []),
      ...(process.argv.includes("--webhook-groups-view")
        ? ["tests/integration/webhook-groups-view.test.ts"]
        : []),
      ...(process.argv.includes("--webhook-corpus")
        ? ["tests/integration/webhook-classification-corpus.test.ts"]
        : []),
      ...(process.argv.includes("--webhook-revision")
        ? ["tests/integration/webhook-configured-revision.test.ts"]
        : []),
      ...(process.argv.includes("--sender")
        ? [
            "tests/integration/sender-identity.test.ts",
            "tests/integration/ingestion-credentials.test.ts",
            "tests/integration/application-monitoring-adapter.test.ts",
          ]
        : []),
      ...(process.argv.includes("--grouping")
        ? ["tests/integration/sender-grouping.test.ts"]
        : []),
    ];
    const tests = spawnSync(
      process.execPath,
      ["node_modules/vitest/vitest.mjs", "run", ...testFiles],
      {
        stdio: "inherit",
        windowsHide: true,
        timeout: 180_000,
        env: { ...env, DATABASE_URL: process.env.DATABASE_URL },
      },
    );
    if (tests.status !== 0) throw new Error("Historical tests failed");
    if (process.argv.includes("--observability"))
      await proveObservabilityControls({
        ...env,
        DATABASE_URL: process.env.DATABASE_URL,
      });
    if (process.argv.includes("--grouping")) {
      const regression = spawnSync(
        process.execPath,
        [
          "node_modules/vitest/vitest.mjs",
          "run",
          "tests/integration/investigation-grouping.test.ts",
        ],
        {
          stdio: "inherit",
          windowsHide: true,
          timeout: 180_000,
          env: { ...env, DATABASE_URL: process.env.DATABASE_URL },
        },
      );
      if (regression.status !== 0)
        throw new Error("Grouping/preparation regression failed");
    }
    if (process.argv.includes("--guard-control")) {
      if (process.argv.includes("--webhook"))
        await proveWebhookControls(
          { ...env, DATABASE_URL: process.env.DATABASE_URL },
          process.argv.includes("--webhook-view"),
          process.argv.includes("--webhook-signing"),
          process.argv.includes("--webhook-grouping"),
          process.argv.includes("--webhook-groups-view"),
          process.argv.includes("--webhook-revision"),
        );
      await proveBoundaryGuard(
        { ...env, DATABASE_URL: process.env.DATABASE_URL },
        "historical",
      );
      if (process.argv.includes("--sender"))
        await proveBoundaryGuard(
          { ...env, DATABASE_URL: process.env.DATABASE_URL },
          "sender",
        );
      if (process.argv.includes("--grouping"))
        await proveBoundaryGuard(
          { ...env, DATABASE_URL: process.env.DATABASE_URL },
          "grouping",
        );
      if (process.argv.includes("--grouping"))
        await proveBoundaryGuard(
          { ...env, DATABASE_URL: process.env.DATABASE_URL },
          "evidence",
        );
    }
    if (process.argv.includes("--stripe-view-controls"))
      await proveStripeViewControls({
        ...env,
        DATABASE_URL: process.env.DATABASE_URL,
      });
    if (process.argv.includes("--build")) {
      const buildConfig = path.join(
        root,
        `.tsconfig-build-${randomUUID()}.json`,
      );
      await mkdir(path.dirname(buildConfig), { recursive: true });
      const tsconfig = JSON.parse(
        await readFile(path.join(root, "tsconfig.json"), "utf8"),
      );
      tsconfig.compilerOptions.incremental = false;
      tsconfig.include = [
        "next-env.d.ts",
        "src/**/*.ts",
        "src/**/*.tsx",
        "scripts/**/*.ts",
        "tests/**/*.ts",
        "prisma/**/*.ts",
        "packages/**/*.ts",
        "*.ts",
        "*.mts",
      ];
      tsconfig.exclude = tsconfig.exclude.filter(
        (entry: string) => entry !== ".next-*",
      );
      await writeFile(buildConfig, JSON.stringify(tsconfig));
      const build = spawnSync(
        process.execPath,
        ["node_modules/next/dist/bin/next", "build", "--webpack"],
        {
          stdio: "inherit",
          windowsHide: true,
          timeout: 240_000,
          env: {
            ...env,
            NODE_ENV: "production",
            SPEKTRACE_NEXT_TSCONFIG: path.relative(root, buildConfig),
            SPEKTRACE_NEXT_DIST_DIR: `.next-history-build-${randomUUID()}`,
          },
        },
      );
      await rm(buildConfig, { force: true });
      if (build.status !== 0) throw new Error("Historical build failed");
    }
    console.log(
      `${process.argv.includes("--webhook") ? "Synthetic webhook acceptance and selected regressions" : process.argv.includes("--grouping") ? "Sender/revision grouping and prior regressions" : process.argv.includes("--sender") ? "Sender identity and historical regression" : "Historical revision"} checkpoint demonstrated with synthetic data in a disposable database. Existing databases untouched.`,
    );
  } finally {
    try {
      if (created)
        await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    } finally {
      await admin.end();
      if (senderConsumer) {
        const target = path.resolve(senderConsumer);
        if (
          path.dirname(target) !== path.resolve(root, "work") ||
          !/^sender-package-review-[a-f0-9-]{36}$/.test(path.basename(target))
        )
          throw new Error("Unsafe consumer cleanup target");
        await rm(target, { recursive: true, force: true });
      }
    }
  }
}
main().catch(() => {
  console.error(
    "Historical checkpoint failed; connection details withheld. See check output above.",
  );
  process.exitCode = 1;
});
