import { afterEach, describe, expect, it, vi } from "vitest";
import { createPayloadProposalGateway } from "@/server/review/payload-proposal-gateway";
import { requestPayloadProposal } from "@/server/dashboard/synthetic-test";

const input = { version: 1 as const, findings: [{ findingIndex: 0, jsonPointer: "/amount", rule: "type" as const, observedType: "string" as const, expectedType: "integer" as const }] };
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("payload proposal provider boundary (simulated HTTP)", () => {
  it("sends only the value-free contract and makes one provider request", async () => {
    vi.stubEnv("THESYS_API_KEY", "offline-key-not-used-for-network");
    const plan = { decision: "propose", operation: "canonical_integer_string_to_integer", findingIndex: 0, jsonPointer: "/amount" };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] })));
    vi.stubGlobal("fetch", fetchMock);
    expect(await createPayloadProposalGateway().propose(input)).toEqual(plan);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const request = JSON.parse(String(call[1].body));
    expect(JSON.parse(request.messages[1].content)).toEqual(input);
    expect(String(call[1].body)).not.toContain("offline-key-not-used-for-network");
  });
  it("refuses hostile pointers without transmitting", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(createPayloadProposalGateway().propose({ ...input, findings: [{ ...input.findings[0]!, jsonPointer: "/__proto__/amount" }] })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("does not retry provider failures or echo response bodies", async () => {
    vi.stubEnv("THESYS_API_KEY", "offline-key-not-used-for-network");
    const fetchMock = vi.fn(async () => new Response("private provider data", { status: 429 })); vi.stubGlobal("fetch", fetchMock);
    await expect(createPayloadProposalGateway().propose(input)).rejects.toThrow("PROPOSAL_GATEWAY_FAILED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("cancels oversized streamed responses", async () => {
    vi.stubEnv("THESYS_API_KEY", "offline-key-not-used-for-network");
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8_193)); }, cancel }))));
    await expect(createPayloadProposalGateway().propose(input)).rejects.toThrow("PROPOSAL_RESPONSE_TOO_LARGE"); expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("reports a safe content-JSON rejection without retaining provider text", async () => {
    vi.stubEnv("THESYS_API_KEY", "offline-key-not-used-for-network");
    const hostile = 'private-body-secret-unique';
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: hostile } }] }), { status: 201 })));
    const diagnostic = vi.fn();
    await expect(createPayloadProposalGateway({ onDiagnostic: diagnostic }).propose(input)).rejects.toThrow("PROPOSAL_CONTENT_NOT_JSON");
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ code: "PROPOSAL_CONTENT_NOT_JSON", finishReason: "length", httpStatus: 201 }));
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(hostile);
  });
  it("rejects extra replacement values without echoing them in errors or diagnostics", async () => {
    vi.stubEnv("THESYS_API_KEY", "offline-key-not-used-for-network");
    const raw = { decision: "propose", operation: "canonical_integer_string_to_integer", findingIndex: 0, jsonPointer: "/amount", inventedValue: "PRIVATE_UNIQUE" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(raw) } }] }))));
    const diagnostic = vi.fn();
    await expect(createPayloadProposalGateway({ onDiagnostic: diagnostic }).propose(input)).rejects.toThrow(/^PROPOSAL_PLAN_INVALID$/);
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ issues: [{ field: "extra_fields", rule: "extra_fields" }] }));
    expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(/inventedValue|PRIVATE_UNIQUE/);
  });
});
describe("local proposal action gate", () => {
  it("is off by default without accessing the provider", async () => {
    vi.stubEnv("NODE_ENV", "development"); vi.stubEnv("SPEKTRACE_PAYLOAD_PROPOSALS_ENABLED", "false"); const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    expect(await requestPayloadProposal({ incidentId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" })).toEqual({ status: "unavailable", code: "PROPOSALS_DISABLED" }); expect(fetchMock).not.toHaveBeenCalled();
  });
  it("cannot be enabled in production", async () => {
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("SPEKTRACE_PAYLOAD_PROPOSALS_ENABLED", "true");
    expect(await requestPayloadProposal({ incidentId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" })).toMatchObject({ code: "PROPOSALS_DISABLED" });
  });
  it("validates the incident reference before any database or provider call", async () => {
    vi.stubEnv("NODE_ENV", "development"); vi.stubEnv("SPEKTRACE_PAYLOAD_PROPOSALS_ENABLED", "true");
    expect(await requestPayloadProposal({ incidentId: "not-a-uuid" })).toMatchObject({ code: "INVALID_INCIDENT_REFERENCE" });
  });
});
