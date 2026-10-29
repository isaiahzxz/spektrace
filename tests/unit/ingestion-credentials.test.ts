import { mkdtemp, readFile, rm, rmdir, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { generateIngestionToken, ingestionTokenHash, ingestionTokenMatches, parseIngestionAuthorization } from "@/lib/ingestion/credential-token";
import { writeCredentialSecretFile } from "@/lib/ingestion/credential-secret-file";

describe("ingestion credential boundary", () => {
  it("accepts generated credentials and rejects modified secrets", () => {
    const one = generateIngestionToken();
    const two = generateIngestionToken();
    expect(one.id).not.toBe(two.id);
    expect(one.token).not.toBe(two.token);
    expect(parseIngestionAuthorization(`Bearer ${one.token}`)?.id).toBe(one.id);
    expect(ingestionTokenMatches(one.token, ingestionTokenHash(one.token))).toBe(true);
    expect(ingestionTokenMatches(two.token, ingestionTokenHash(one.token))).toBe(false);
    expect(ingestionTokenMatches(one.token, "invalid")).toBe(false);
  });

  it("rejects missing, ambiguous, legacy and oversized headers", () => {
    const { token } = generateIngestionToken();
    for (const header of [null, "", "Bearer admin-token", `Bearer ${token} extra`, `Bearer ${token},${token}`, `Bearer  ${token}`, `Basic ${token}`, `Bearer ${"x".repeat(10000)}`, `Bearer ${token}\n`]) {
      expect(parseIngestionAuthorization(header)).toBeNull();
    }
  });

  it("delivers a private secret file once and refuses overwrite", async () => {
    const root = path.join(os.homedir(), ".spektrace-credential-test");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(path.join(root, "key-"));
    const file = path.join(dir, "credential.json");
    const first = generateIngestionToken();
    try {
      await writeCredentialSecretFile(file, first);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ credentialId: first.id, token: first.token });
      await expect(writeCredentialSecretFile(file, generateIngestionToken())).rejects.toThrow();
      expect(JSON.parse(await readFile(file, "utf8")).token).toBe(first.token);
    } finally { await rm(file, { force: true }); await rmdir(dir); }
  });

  it("rejects repository and relative secret destinations", async () => {
    await expect(writeCredentialSecretFile("key.json", generateIngestionToken())).rejects.toThrow("absolute");
    await expect(writeCredentialSecretFile(path.join(process.cwd(), "key.json"), generateIngestionToken())).rejects.toThrow("outside");
    await expect(writeCredentialSecretFile(path.join(path.parse(os.homedir()).root, "key.json"), generateIngestionToken())).rejects.toThrow("profile");
  });

  it("refuses a parent directory that permits other users to write", async () => {
    const root = path.join(os.homedir(), ".spektrace-credential-test");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(path.join(root, "shared-"));
    const file = path.join(dir, "key.json");
    try {
      if (process.platform === "win32") {
        execFileSync("icacls", [dir, "/grant", "*S-1-1-0:(OI)(CI)(M)"], { stdio: "pipe", windowsHide: true });
      } else {
        const { chmod } = await import("node:fs/promises");
        await chmod(dir, 0o777);
      }
      await expect(writeCredentialSecretFile(file, generateIngestionToken())).rejects.toThrow();
      await expect(readFile(file)).rejects.toThrow();
    } finally { await rm(file, { force: true }); await rmdir(dir); }
  });
});
