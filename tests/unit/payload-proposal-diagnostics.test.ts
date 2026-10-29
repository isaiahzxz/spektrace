import { describe, expect, it } from "vitest";
import { inspectProposalResponse } from "@/lib/payload-proposal/response-diagnostics";

const input = { version: 1 as const, findings: [{ findingIndex: 0, jsonPointer: "/amount", rule: "type" as const, observedType: "string" as const, expectedType: "integer" as const }] };
const plan = { decision: "propose", operation: "canonical_integer_string_to_integer", findingIndex: 0, jsonPointer: "/amount" };
const envelope = (value: unknown, finish: unknown = "stop") => JSON.stringify({ choices: [{ finish_reason: finish, message: { content: JSON.stringify(value) } }] });
describe("safe payload proposal response diagnostics", () => {
  it.each([
    [{ operation: "PRIVATE_UNIQUE" }, "missing"],
    [{ decision: "PRIVATE_UNIQUE" }, "unsupported"],
    [{ decision: { nested: "PRIVATE_UNIQUE" } }, "invalid_type"],
  ])("identifies the decision failure without disclosing the rejected value", (value, state) => {
    const result = inspectProposalResponse(envelope(value), input);
    expect(result).toMatchObject({ ok: false, diagnostic: { decisionState: state, code: "PROPOSAL_PLAN_INVALID" } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_UNIQUE");
  });
  it("accepts an offered plan and reports only bounded metadata", () => {
    expect(inspectProposalResponse(envelope(plan), input, 201)).toMatchObject({ ok: true, plan, diagnostic: { code: "PROPOSAL_PLAN_ACCEPTED", httpStatus: 201, finishReason: "stop" } });
  });
  it("keeps deliberate model abstention separate from a format rejection", () => {
    expect(inspectProposalResponse(envelope({ decision: "abstain", reasonCode: "INSUFFICIENT_EVIDENCE" }), input)).toMatchObject({ ok: true, diagnostic: { code: "PROPOSAL_PLAN_ABSTAINED" } });
  });
  it.each(["not json PRIVATE_UNIQUE", "", '{"choices":'])("classifies invalid outer JSON without echoing it", text => {
    const result = inspectProposalResponse(text, input);
    expect(result).toMatchObject({ ok: false, diagnostic: { code: "PROPOSAL_ENVELOPE_NOT_JSON" } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_UNIQUE");
  });
  it.each([{ choices: [] }, { choices: [{ message: { content: ["PRIVATE_UNIQUE"] } }] }, { unknown: "PRIVATE_UNIQUE" }])("reports invalid envelopes with known field names only", value => {
    const result = inspectProposalResponse(JSON.stringify(value), input);
    expect(result).toMatchObject({ ok: false, diagnostic: { code: "PROPOSAL_ENVELOPE_INVALID" } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_UNIQUE");
  });
  it("preserves the truncation signal without retaining malformed content", () => {
    const result = inspectProposalResponse(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: 'PRIVATE_UNIQUE{"decision"' } }] }), input);
    expect(result).toMatchObject({ ok: false, diagnostic: { code: "PROPOSAL_CONTENT_NOT_JSON", finishReason: "length" } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_UNIQUE");
  });
  it("does not include attacker-controlled key names, values, or Zod messages", () => {
    const result = inspectProposalResponse(envelope({ ...plan, "PRIVATE_KEY_UNIQUE": "PRIVATE_VALUE_UNIQUE" }), input);
    expect(result).toMatchObject({ ok: false, diagnostic: { code: "PROPOSAL_PLAN_INVALID", issues: [{ field: "extra_fields", rule: "extra_fields" }] } });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_KEY_UNIQUE|PRIVATE_VALUE_UNIQUE|unrecognized_keys|Unrecognized/);
  });
  it("identifies a bad operation by its contract field and rule, not its value", () => {
    const result = inspectProposalResponse(envelope({ ...plan, operation: "PRIVATE_OPERATION_UNIQUE" }), input);
    expect(result).toMatchObject({ ok: false, diagnostic: { issues: [{ field: "operation", rule: "value" }] } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_OPERATION_UNIQUE");
  });
  it.each([{ ...plan, jsonPointer: "/unoffered" }, { ...plan, findingIndex: 1 }])("rejects a valid-shaped plan that was not offered", value => {
    expect(inspectProposalResponse(envelope(value), input)).toMatchObject({ ok: false, diagnostic: { code: "PROPOSAL_PLAN_NOT_OFFERED" } });
  });
  it("counts UTF-8 bytes before parsing, rather than JavaScript characters", () => {
    const text = "é".repeat(4_097);
    expect(inspectProposalResponse(text, input)).toEqual({ ok: false, diagnostic: { code: "PROPOSAL_RESPONSE_TOO_LARGE", responseBytes: 8_194 } });
  });
  it("enforces the existing inner-content character limit", () => {
    const result = inspectProposalResponse(envelope("a".repeat(2_049)), input);
    expect(result).toMatchObject({ ok: false, diagnostic: { code: "PROPOSAL_CONTENT_TOO_LARGE" } });
  });
  it("does not coerce or expose arbitrary finish-reason values", () => {
    for (const reason of ["PRIVATE_UNIQUE", { toString: "PRIVATE_UNIQUE" }]) {
      const result = inspectProposalResponse(envelope(plan, reason), input, 999);
      expect(result).toMatchObject({ ok: true, diagnostic: { finishReason: "unknown" } });
      expect(JSON.stringify(result)).not.toContain("PRIVATE_UNIQUE");
      expect(result.diagnostic).not.toHaveProperty("httpStatus");
    }
  });
});
