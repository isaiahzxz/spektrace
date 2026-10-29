import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  inspectProjectSnapshot,
  exportProjectSnapshot,
  snapshotPathAllowed,
} from "@/lib/project-snapshot";
describe("snapshot hygiene", () => {
  it("excludes private/configuration state while retaining the complete main source categories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "spek-snapshot-"));
    try {
      for (const name of [
        "src/feature.ts",
        "prisma/migrations/one/migration.sql",
        "packages/express-monitoring/src/index.ts",
        "scripts/check.ts",
        "tests/unit/check.test.ts",
        "docs/README.md",
        "public/icon.svg",
        ".env.example",
        "package-lock.json",
        ".env",
        "next-env.d.ts",
        "tsconfig.tsbuildinfo",
        "src/generated/prisma/client.ts",
        "packages/express-monitoring/dist/index.js",
        ".next-build-fixture/types/page.ts",
        "work/verify-report.json",
        "sources/reference.ts",
        "tests/fixtures/private.pem",
      ]) {
        await mkdir(path.dirname(path.join(root, name)), { recursive: true });
        await writeFile(path.join(root, name), name);
      }
      const manifest = await inspectProjectSnapshot(root);
      expect(manifest.files.map((f) => f.path)).toEqual([
        ".env.example",
        "docs/README.md",
        "package-lock.json",
        "packages/express-monitoring/src/index.ts",
        "prisma/migrations/one/migration.sql",
        "public/icon.svg",
        "scripts/check.ts",
        "src/feature.ts",
        "tests/unit/check.test.ts",
      ]);
      const result = await exportProjectSnapshot(root);
      expect(result.generatedAndPrivateFilesExcluded).toBe(true);
      const exported = JSON.parse(
        await readFile(
          path.join(result.directory, "snapshot-manifest.json"),
          "utf8",
        ),
      );
      expect(exported.files).toEqual(manifest.files);
      expect(snapshotPathAllowed("../.env")).toBe(false);
      expect(snapshotPathAllowed("src/.env.local")).toBe(false);
    } finally {
      const resolved = path.resolve(root);
      if (!resolved.startsWith(path.join(os.tmpdir(), "spek-snapshot-")))
        throw Error("Unsafe fixture cleanup");
      await rm(resolved, { recursive: true, force: true });
    }
  });
});
