import { z } from "zod";

const SERVICE = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const ENV = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const INTEGRATION = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

const entrySchema = z
  .object({
    integrationKey: INTEGRATION,
    apiKey: SERVICE,
    environment: ENV.optional(),
  })
  .strict();

export type DeploymentImportAllowlistEntry = z.infer<typeof entrySchema>;

export function loadDeploymentImportAllowlistFromEnv(): DeploymentImportAllowlistEntry[] {
  const raw = process.env.SPEKTRACE_DEPLOYMENT_IMPORT_ALLOWLIST;
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

export function findDeploymentAllowlistEntry(
  entries: DeploymentImportAllowlistEntry[],
  input: { integrationKey: string; apiKey: string; environment: string },
): DeploymentImportAllowlistEntry | null {
  for (const entry of entries) {
    if (entry.integrationKey !== input.integrationKey || entry.apiKey !== input.apiKey) {
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
