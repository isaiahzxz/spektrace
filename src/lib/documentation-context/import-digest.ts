import { createHash } from "node:crypto";

export function computeDocumentationImportDigest(
  documents: Array<{ documentId: string; contentSha256: string }>,
): string {
  const canonical = documents
    .map((row) => ({
      documentId: row.documentId,
      contentSha256: row.contentSha256.toLowerCase(),
    }))
    .sort((a, b) => a.documentId.localeCompare(b.documentId));
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

export function sha256Utf8(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
