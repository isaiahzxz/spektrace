import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertSigningFreshness, createSyntheticSignatureVerifier } from "@/server/webhooks/synthetic-signature";

describe("synthetic signing configuration", () => {
  const key = () => ({ keyId: randomUUID(), workspaceId: randomUUID(), credentialId: randomUUID(), principalRef: randomUUID(),
    principalKind: "client_id" as const, secretHex: randomBytes(32).toString("hex"), expiresAt: new Date(Date.now() + 60_000).toISOString() });
  it("refuses empty, short, duplicate and shared-secret configurations without echoing values", () => {
    const k = key();
    for (const keys of [[], [{ ...k, secretHex: "private-short-secret" }], [k, k], [k, { ...key(), secretHex: k.secretHex }]]) {
      expect(() => createSyntheticSignatureVerifier(keys)).toThrow();
      try { createSyntheticSignatureVerifier(keys); } catch (error) { expect(String(error)).not.toContain(k.secretHex); expect(String(error)).not.toContain("private-short-secret"); }
    }
  });
  it("bounds signature age and key expiry", () => {
    const now = Math.floor(Date.now() / 1000); const expiresAt = new Date(Date.now() + 60_000).toISOString();
    expect(() => assertSigningFreshness({ timestamp: now, expiresAt })).not.toThrow();
    for (const timestamp of [now - 301, now + 32]) expect(() => assertSigningFreshness({ timestamp, expiresAt })).toThrow();
    expect(() => assertSigningFreshness({ timestamp: now, expiresAt: new Date(Date.now() - 1).toISOString() })).toThrow();
  });
});
