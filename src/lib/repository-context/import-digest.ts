import { createHash } from "node:crypto";

export function computeRepositoryImportDigest(
  files: Array<{ relativePath: string; sourceSha256: string }>,
): string {
  const canonical = files
    .map((row) => ({ relativePath: row.relativePath, sourceSha256: row.sourceSha256.toLowerCase() }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

export function sha256Utf8(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
