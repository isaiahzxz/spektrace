import { describe, expect, it } from "vitest";
import { buildPayloadProposalPrompt } from "@/lib/payload-proposal/prompt";
import { proposalPlanSchema } from "@/lib/payload-proposal/contract";
import { inspectProposalResponse } from "@/lib/payload-proposal/response-diagnostics";

const finding = { findingIndex: 7, jsonPointer: "/payment/quantity", rule: "type" as const, observedType: "string" as const, expectedType: "integer" as const };
const input = { version: 1 as const, findings: [finding] };
function offered(text: string): unknown[] { return text.split("ALLOWED_RESPONSE_OBJECTS_BEGIN\n")[1]!.split("\nALLOWED_RESPONSE_OBJECTS_END")[0]!.split("\n").map(line => JSON.parse(line)); }
describe("payload proposal response instructions", () => {
  it("offers complete valid objects for actual eligible targets, plus both abstentions", () => {
    const options = offered(buildPayloadProposalPrompt(input));
    expect(options).toEqual([
      { decision: "propose", operation: "canonical_integer_string_to_integer", findingIndex: 7, jsonPointer: "/payment/quantity" },
      { decision: "abstain", reasonCode: "UNSUPPORTED_TRANSFORMATION" },
      { decision: "abstain", reasonCode: "INSUFFICIENT_EVIDENCE" },
    ]);
    for (const option of options) {
      expect(proposalPlanSchema.safeParse(option).success).toBe(true);
      expect(inspectProposalResponse(JSON.stringify({ choices: [{ message: { content: JSON.stringify(option) } }] }), input).ok).toBe(true);
    }
  });
  it("does not offer a fixture-specific amount target when another field is supplied", () => {
    expect(buildPayloadProposalPrompt(input)).not.toContain("/amount");
    expect(buildPayloadProposalPrompt(input)).not.toContain('"100"');
  });
  it("rejects untrusted additional fields before building the system message", () => {
    expect(() => buildPayloadProposalPrompt({ ...input, body: "PRIVATE_VALUE_UNIQUE" } as typeof input)).toThrow();
  });
  it("keeps a maximum normal batch within the existing request export budget", () => {
    const many = { version: 1 as const, findings: Array.from({ length: 32 }, (_, i) => ({ ...finding, findingIndex: i, jsonPointer: `/field_${i}` })) };
    expect(Buffer.byteLength(JSON.stringify({ model: "openai/gpt-4.1", temperature: 0, max_tokens: 256, response_format: { type: "json_object" }, messages: [{ role: "system", content: buildPayloadProposalPrompt(many) }, { role: "user", content: JSON.stringify(many) }] }), "utf8")).toBeLessThanOrEqual(16_384);
  });
});
