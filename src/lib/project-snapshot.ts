import { createHash, randomUUID } from "node:crypto";
import {
  readdir,
  readFile,
  mkdir,
  copyFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
const rootFiles = new Set([
  "README.md",
  "DESIGN.md",
  "AGENTS.md",
  "package.json",
  "package-lock.json",
  ".env.example",
  ".gitignore",
  "tsconfig.json",
  "eslint.config.mjs",
  "vitest.config.ts",
  "compose.yaml",
  "prisma.config.ts",
  "next.config.ts",
  "postcss.config.mjs",
  ".nvmrc",
  "skills-lock.json",
]);
const roots = new Set([
  "src",
  "prisma",
  "packages",
  "scripts",
  "tests",
  "docs",
  "public",
]);
export function snapshotPathAllowed(relative: string) {
  const name = relative.replaceAll("\\", "/"),
    parts = name.split("/");
  if (
    parts.some(
      (part) =>
        part === ".." ||
        part === "." ||
        [
          "node_modules",
          "dist",
          "generated",
          ".git",
          "work",
          "sources",
        ].includes(part) ||
        part.startsWith(".next") ||
        part.endsWith(".tsbuildinfo") ||
        /\.(pem|key|p12|pfx)$/i.test(part) ||
        part === "next-env.d.ts" ||
        (part.startsWith(".env") && part !== ".env.example"),
    )
  )
    return false;
  if (
    parts[0] === "docs" &&
    parts[1] === "verification" &&
    /\.(png|json|txt|log)$/i.test(name)
  )
    return false;
  return parts.length === 1 ? rootFiles.has(name) : roots.has(parts[0]);
}
export async function inspectProjectSnapshot(root: string) {
  const base = path.resolve(root),
    files: { path: string; bytes: number; sha256: string }[] = [];
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name),
        relative = path.relative(base, absolute).replaceAll("\\", "/");
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (
          roots.has(relative) ||
          snapshotPathAllowed(relative + "/placeholder")
        )
          await visit(absolute);
      } else if (entry.isFile() && snapshotPathAllowed(relative)) {
        const bytes = await readFile(absolute);
        files.push({
          path: relative,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
  }
  await visit(base);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    version: 1,
    files,
    exclusions: [
      "private environment/credentials",
      "dependencies and generated types/builds",
      "work archives and verification transcripts",
      "synced sources",
      "separate genui-chat-app experiment",
    ],
    secretScanGuarantee: false,
  };
}
export async function exportProjectSnapshot(root: string) {
  const base = path.resolve(root),
    directory = path.join(base, "work", "project-snapshots", randomUUID()),
    manifest = await inspectProjectSnapshot(base);
  if (
    !directory.startsWith(
      path.join(base, "work", "project-snapshots") + path.sep,
    )
  )
    throw Error("Unsafe snapshot target");
  await mkdir(directory, { recursive: true });
  for (const file of manifest.files) {
    const target = path.join(directory, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(base, file.path), target);
    const copied = await readFile(target);
    if (createHash("sha256").update(copied).digest("hex") !== file.sha256)
      throw Error("Source changed during snapshot");
  }
  await writeFile(
    path.join(directory, "snapshot-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx" },
  );
  return {
    directory,
    files: manifest.files.length,
    generatedAndPrivateFilesExcluded: true,
    contentReviewStillRequired: true,
  };
}
