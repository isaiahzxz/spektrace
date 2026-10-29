import { z } from "zod";

const SERVICE = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const ENV = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const SOURCE_KEY = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const DOC_ID = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);

const entrySchema = z
  .object({
    sourceKey: SOURCE_KEY,
    apiKey: SERVICE,
    environment: ENV.optional(),
    allowedDocumentIds: z.array(DOC_ID).min(1).max(64),
    trustedSourceUrls: z
      .record(DOC_ID, z.string().trim().url().max(300).refine((v) => v.startsWith("https://")))
      .optional(),
  })
  .strict();

export type DocumentationImportAllowlistEntry = z.infer<typeof entrySchema>;

export function parseDocumentationImportAllowlist(raw: string | undefined): DocumentationImportAllowlistEntry[] {
  if (!raw?.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    const list = z.array(entrySchema).safeParse(parsed);
    return list.success ? list.data : [];
  } catch {
    return [];
  }
}

export function loadDocumentationImportAllowlistFromEnv(): DocumentationImportAllowlistEntry[] {
  return parseDocumentationImportAllowlist(process.env.SPEKTRACE_DOCUMENTATION_IMPORT_ALLOWLIST);
}

export function findDocumentationAllowlistEntry(
  entries: DocumentationImportAllowlistEntry[],
  input: { sourceKey: string; apiKey: string; environment: string },
): DocumentationImportAllowlistEntry | null {
  for (const entry of entries) {
    if (entry.sourceKey !== input.sourceKey || entry.apiKey !== input.apiKey) {
      continue;
    }
    const env = entry.environment ?? "default";
    if (env !== input.environment) {
      continue;
    }
    return entry;
  }
  return null;
}
