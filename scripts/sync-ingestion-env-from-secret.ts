import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

async function main() {
  const secretFile = process.argv[2];
  const envPath = path.join(process.cwd(), ".env");
  if (!secretFile) {
    throw new Error("Absolute secret file path required");
  }
  const parsed = JSON.parse(await readFile(secretFile, "utf8")) as { token?: string };
  if (!parsed.token?.trim()) {
    throw new Error("Secret file missing token");
  }
  const token = parsed.token.trim();
  let envText = "";
  try {
    envText = await readFile(envPath, "utf8");
  } catch {
    envText = "";
  }
  const line = `SPEKTRACE_INGESTION_API_TOKEN="${token.replaceAll('"', '\\"')}"`;
  const pattern = /^SPEKTRACE_INGESTION_API_TOKEN=.*$/m;
  const next = pattern.test(envText)
    ? envText.replace(pattern, line)
    : `${envText.trimEnd()}${envText.endsWith("\n") || envText.length === 0 ? "" : "\n"}${line}\n`;
  await writeFile(envPath, next, "utf8");
  console.log("SPEKTRACE_INGESTION_API_TOKEN updated in .env (value not printed)");
}

void main().catch(() => {
  process.exitCode = 1;
});
