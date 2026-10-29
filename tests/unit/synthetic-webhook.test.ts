import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sanitizeSyntheticWebhook } from "@/lib/ingestion/synthetic-webhook";

describe("synthetic webhook privacy projection", () => {
  it("retains only the bounded fixture amount and omission names", () => {
    const privateEmail = `unique-private-${randomUUID()}@example.test`;
    const result = sanitizeSyntheticWebhook({ amount: "100", email: privateEmail, name: "Private Person", password: "secret-fixture", cardNumber: "4242424242424242" });
    expect(JSON.stringify(result)).not.toContain(privateEmail);
    expect(result).toEqual({ payload: { amount: "100" }, protection: { policy: "synthetic-payments@1", omittedFields: ["email", "name", "password", "cardNumber"] } });
    expect(JSON.stringify(result)).not.toContain("unique-private");
    expect(JSON.stringify(result)).not.toContain("4242424242424242");
  });
  it("rejects sensitive retained values, unknown fields and non-JSON shapes", () => {
    for (const body of [{ amount: "unique-private@example.test" }, { amount: "4242424242424242" }, { amount: 4242424242424242 },
      { amount: "Bearer private" }, { token: "private" }, { amount: [] }, [], null, { amount: Infinity }])
      expect(() => sanitizeSyntheticWebhook(body)).toThrow();
    expect(sanitizeSyntheticWebhook({})).toMatchObject({ payload: {} });
    expect(sanitizeSyntheticWebhook({ amount: null })).toMatchObject({ payload: { amount: null } });
  });
});
