import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { validateJsonSchemaPayload } from "@/lib/validation/validate-json-schema";
import { generatePayloadProposal } from "@/server/review/payload-proposal";
import type { ProposalAdapter } from "@/lib/payload-proposal/contract";

function fixture(amount: unknown = "100") {
  const schema = { type: "object", required: ["amount"], properties: { amount: { type: "integer" }, memo: { type: "string" } } };
  const body = { amount, memo: "local-only-marker" };
  const checked = validateJsonSchemaPayload(schema, body);
  const spec = { id: "bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb", workspaceId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", apiKey: "payments-api", environment: "default", name: "Synthetic payments", version: "1.0.0", sourceSha256: "b".repeat(64), openApiVersion: "3.1.0", parsedDocument: { openapi: "3.1.0", paths: { "/payments": { post: { requestBody: { content: { "application/json": { schema } } } } } } } };
  const row = { id: "cccccccc-cccc-4ccc-accc-cccccccccccc", workspaceId: spec.workspaceId, apiKey: spec.apiKey, environment: spec.environment, httpMethod: "POST", requestPath: "/payments", statusCode: 400, status: "NEW", approvedAt: null, apiSpecId: spec.id, apiSpec: spec, sanitizedRequestBody: body, validationStatus: checked.status === "mismatch" ? "MISMATCH" : "PASSED", validationEvidence: { version: 1, checkedAt: "2026-02-01T14:00:00.000Z", outcome: checked.status === "mismatch" ? "MISMATCH" : "PASSED", reasonCode: "SCHEMA_MISMATCH", reasonMessage: null, plainEnglishSummary: null, scope: { label: "openapi_request_body", openApiVersion: "3.1.0", matchedPath: "/payments", matchedMethod: "POST", covers: "json_request_body_only" }, specRevision: { apiSpecId: spec.id, sourceSha256: spec.sourceSha256 }, validator: { engine: "ajv", schemaDialect: "https://json-schema.org/draft/2020-12/schema" }, findings: checked.status === "mismatch" ? checked.evidence : [], redactedPaths: [] as string[] } };
  const db = { incident: { findFirst: vi.fn(async ({ where }: { where: { id: string; workspaceId: string } }) => where.id === row.id && where.workspaceId === row.workspaceId ? row : null) }, apiSpec: { findFirst: vi.fn(async ({ where }: { where: { id: string; workspaceId: string } }) => where.id === spec.id && where.workspaceId === spec.workspaceId ? spec : null) } };
  const propose = vi.fn<ProposalAdapter["propose"]>(async (input) => ({ decision: "propose", operation: "canonical_integer_string_to_integer", findingIndex: input.findings[0]!.findingIndex, jsonPointer: input.findings[0]!.jsonPointer }));
  const adapter: ProposalAdapter = { provider: "offline-simulation", model: "fixture", propose };
  const run = () => generatePayloadProposal(db as unknown as PrismaClient, row.workspaceId, row.id, adapter);
  return { row, spec, db, propose, adapter, run };
}

describe("read-only sandbox payload proposal service (simulated model and database)", () => {
  it("builds and pinned-spec checks a lossless candidate without exporting body values or mutating evidence", async () => {
    const f = fixture(); const before = JSON.stringify(f.row);
    const result = await f.run();
    expect(result).toMatchObject({ status: "ready", code: "PINNED_BODY_CHECK_PASSED", pinnedSpecId: f.spec.id });
    if (result.status !== "ready") return;
    expect(JSON.parse(result.candidateText)).toEqual({ amount: 100, memo: "local-only-marker" });
    expect(result.candidateSha256).toHaveLength(64);
    expect(JSON.stringify(f.row)).toBe(before);
    expect(f.propose).toHaveBeenCalledTimes(1);
    const transmitted = JSON.stringify(f.propose.mock.calls[0]![0]);
    expect(transmitted).not.toContain("local-only-marker"); expect(transmitted).not.toContain("100"); expect(transmitted).not.toContain("payments-api");
  });
  it.each([["12.5", "NO_LOSSLESS_TRANSFORMATION"], ["not-an-integer", "NO_LOSSLESS_TRANSFORMATION"], ["9007199254740992", "BODY_PROTECTION_BLOCKED"]])("refuses %s before calling the model", async (amount, code) => {
    const f = fixture(amount); expect(await f.run()).toMatchObject({ status: "needs_human_input", code }); expect(f.propose).not.toHaveBeenCalled();
  });
  it("refuses a passing body check rather than inventing a correction", async () => {
    const f = fixture(100); expect(await f.run()).toMatchObject({ code: "NO_ELIGIBLE_MISMATCH" }); expect(f.propose).not.toHaveBeenCalled();
  });
  it("enforces workspace isolation", async () => {
    const f = fixture(); expect(await generatePayloadProposal(f.db as unknown as PrismaClient, "other-workspace", f.row.id, f.adapter)).toMatchObject({ code: "INCIDENT_NOT_FOUND" }); expect(f.propose).not.toHaveBeenCalled();
  });
  it.each(["apiKey", "environment", "workspaceId"] as const)("refuses a pinned specification from a different %s", async (field) => {
    const f = fixture(); f.spec[field] = "different";
    expect(await f.run()).toMatchObject({ code: "PINNED_SPEC_SCOPE_MISMATCH" }); expect(f.propose).not.toHaveBeenCalled();
  });
  it("refuses malformed, redacted, or stale original evidence", async () => {
    for (const kind of ["redaction", "hash", "findings"] as const) {
      const f = fixture();
      if (kind === "redaction") f.row.validationEvidence.redactedPaths.push("/amount");
      if (kind === "hash") f.row.validationEvidence.specRevision.sourceSha256 = "stale";
      if (kind === "findings") f.row.validationEvidence.findings = [];
      expect(await f.run()).toMatchObject({ code: "INCOMPLETE_OR_STALE_EVIDENCE" }); expect(f.propose).not.toHaveBeenCalled();
    }
  });
  it("rejects invented replacement values and pointers not supplied to the model", async () => {
    for (const payload of [{ decision: "propose", operation: "canonical_integer_string_to_integer", findingIndex: 0, jsonPointer: "/amount", value: 1 }, { decision: "propose", operation: "canonical_integer_string_to_integer", findingIndex: 0, jsonPointer: "/memo" }]) {
      const f = fixture(); f.propose.mockResolvedValue(payload); expect(await f.run()).toMatchObject({ code: "PROPOSAL_PLAN_REJECTED" });
    }
  });
  it("does not present a candidate that still violates another constraint", async () => {
    const f = fixture(); f.spec.parsedDocument.paths["/payments"].post.requestBody.content["application/json"].schema.properties.amount = { type: "integer", minimum: 200 } as { type: string };
    expect(await f.run()).toMatchObject({ code: "CANDIDATE_BODY_CHECK_FAILED" });
  });
  it("discards the proposal if source data changes while the model runs", async () => {
    const f = fixture(); f.propose.mockImplementation(async (input) => { f.row.sanitizedRequestBody.memo = "changed"; return { decision: "propose", operation: "canonical_integer_string_to_integer", findingIndex: input.findings[0]!.findingIndex, jsonPointer: "/amount" }; });
    expect(await f.run()).toMatchObject({ code: "SOURCE_CHANGED_DURING_PROPOSAL" });
  });
  it("returns a fixed provider failure without leaking thrown text or retrying", async () => {
    const f = fixture(); f.propose.mockRejectedValue(new Error("secret raw provider body"));
    expect(await f.run()).toEqual({ status: "unavailable", code: "PROPOSAL_PROVIDER_FAILED" }); expect(f.propose).toHaveBeenCalledTimes(1);
  });
});
