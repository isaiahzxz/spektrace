import { z } from "zod";

const SERVICE = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const ENV = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const REPO = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._\-/]+$/);

const entrySchema = z
  .object({
    repository: REPO,
    apiKey: SERVICE,
    environment: ENV.optional(),
    allowedPathPrefixes: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(200)
          .refine((value) => !value.includes("..") && !value.startsWith("/") && !value.startsWith("\\")),
      )
      .min(1)
      .max(32),
  })
  .strict();

export type RepositoryImportAllowlistEntry = z.infer<typeof entrySchema>;

export function parseRepositoryImportAllowlist(raw: string | undefined): RepositoryImportAllowlistEntry[] {
  if (!raw?.trim()) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  const list = z.array(entrySchema).safeParse(parsed);
  return list.success ? list.data : [];
}

export function loadRepositoryImportAllowlistFromEnv(): RepositoryImportAllowlistEntry[] {
  return parseRepositoryImportAllowlist(process.env.SPEKTRACE_REPOSITORY_IMPORT_ALLOWLIST);
}

export function findAllowlistEntry(
  entries: RepositoryImportAllowlistEntry[],
  input: { repository: string; apiKey: string; environment: string },
): RepositoryImportAllowlistEntry | null {
  for (const entry of entries) {
    if (entry.repository !== input.repository || entry.apiKey !== input.apiKey) {
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
