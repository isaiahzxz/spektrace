import { describe, expect, it } from "vitest";
import { createIntegerCandidate, proposalPlanSchema, safeProposalBody } from "@/lib/payload-proposal/contract";
describe("lossless local payload candidates", () => {
  it("converts only the selected field without mutating the stored body", () => {
    const body = { amount: "100", currency: "usd" };
    expect(JSON.parse(createIntegerCandidate(body, "/amount")!.candidateText)).toEqual({ amount: 100, currency: "usd" });
    expect(body).toEqual({ amount: "100", currency: "usd" });
  });
  it.each(["12.5", "not-an-integer", " 100", "100 ", "+100", "00100", "1e2", "100.0", "-0", "9007199254740992"])("refuses ambiguous or lossy value %s", (amount) => {
    expect(createIntegerCandidate({ amount }, "/amount")).toBeNull();
  });
  it.each(["0", "-12", "42"])("preserves the canonical integer value %s", (amount) => {
    expect(JSON.parse(createIntegerCandidate({ amount }, "/amount")!.candidateText).amount).toBe(Number(amount));
  });
  it.each(["", "/", "/__proto__/amount", "/constructor", "/missing", "/items/0/amount", "/amount~1x"])("refuses unsafe or unsupported pointer %s", (pointer) => {
    expect(createIntegerCandidate({ amount: "100", items: [{ amount: "100" }] }, pointer)).toBeNull();
  });
  it("refuses redacted, omitted, secret-key, PAN and prototype-bearing bodies", () => {
    for (const body of [{ amount: "[REDACTED]" }, { amount: "100", token: "secret" }, { amount: "100", note: "[OMITTED:DEPTH_LIMIT]" }, { amount: "100", card: "4111111111111111" }, JSON.parse('{"amount":"100","__proto__":{"x":1}}')]) expect(safeProposalBody(body)).toBeNull();
  });
  it("refuses model-created values, extra fields, and arbitrary operations", () => {
    const plan = { decision: "propose", operation: "canonical_integer_string_to_integer", findingIndex: 0, jsonPointer: "/amount" };
    expect(proposalPlanSchema.safeParse(plan).success).toBe(true);
    expect(proposalPlanSchema.safeParse({ ...plan, value: 100 }).success).toBe(false);
    expect(proposalPlanSchema.safeParse({ ...plan, operation: "round_decimal" }).success).toBe(false);
  });
});
