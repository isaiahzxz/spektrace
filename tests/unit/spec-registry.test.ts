import { describe, expect, it } from "vitest";
import { clientAttributionSchema } from "@/lib/ingestion/client-attribution";
import { countDocumentedOperations, parseOpenApiSource } from "@/lib/openapi/document";
import { compareOpenApiDocuments } from "@/lib/openapi/semantic-diff";
import { decideActivation, decideImport, observedHealth, relateIncident } from "@/lib/specs/revision-decisions";

const document = {
  openapi: "3.1.0",
  info: { title: "Core Payments & Checkout API", version: "1.0.0" },
  paths: {
    "/payments": {
      post: {
        requestBody: { content: { "application/json": { schema: { type: "object", required: ["amount"], properties: { amount: { type: "integer", minimum: 1 } } } } } },
        responses: { "201": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/health": { get: { responses: { "200": { description: "ok" } } } },
  },
};

describe("specification registry decisions", () => {
  it("counts path and method operations and ignores metadata keys", () => {
    const counted = countDocumentedOperations({
      paths: { "/payments": { summary: "ignore", parameters: [], post: {}, get: {} } },
    });
    expect(counted.operations).toBe(2);
  });

  it("rejects remote refs and yaml", () => {
    expect(() => parseOpenApiSource("openapi: 3.1.0")).toThrow(/YAML/);
    expect(() => parseOpenApiSource(JSON.stringify({ ...document, paths: { "/x": { $ref: "https://example.test/a" } } }))).toThrow(/local/);
  });

  it("replays the same hash and conflicts on a changed version", () => {
    expect(decideImport({ sourceSha256: "a", version: "1" }, { sourceSha256: "a", version: "1" })).toBe("replay");
    expect(decideImport({ sourceSha256: "a", version: "1" }, { sourceSha256: "b", version: "1" })).toBe("conflict");
  });

  it("rejects an older activation and replays the current one", () => {
    expect(decideActivation({ id: "new", revisionSequence: 3 }, { id: "new", revisionSequence: 3 })).toBe("replay");
    expect(decideActivation({ id: "new", revisionSequence: 3 }, { id: "old", revisionSequence: 2 })).toBe("stale");
    expect(decideActivation(null, { id: "old", revisionSequence: 1 })).toBe("activate");
  });

  it("does not call a service healthy when nothing was captured", () => {
    expect(observedHealth({ captured: 0, mismatches: 0, supported: 0, incomplete: 0 })).toBe("No captured data");
    expect(observedHealth({ captured: 2, mismatches: 1, supported: 2, incomplete: 0 })).toBe("Observed mismatches");
    expect(observedHealth({ captured: 2, mismatches: 0, supported: 2, incomplete: 0 })).toBe("No mismatches observed in captured requests");
  });
});

describe("client attribution", () => {
  it("accepts partial metadata and rejects secret-like values", () => {
    expect(clientAttributionSchema.parse({ platform: "iOS" })).toEqual({ platform: "iOS" });
    expect(clientAttributionSchema.safeParse({ sdkName: "Bearer token" }).success).toBe(false);
    expect(clientAttributionSchema.safeParse({ applicationName: "a@b.test" }).success).toBe(false);
  });
});

describe("semantic comparison", () => {
  it("separates a required request change from a response change and leaves oneOf unknown", () => {
    const later = JSON.parse(JSON.stringify(document)) as {
      paths: { "/payments": { post: { requestBody: { content: { "application/json": { schema: { required: string[]; properties: Record<string, unknown> } } } }; responses: { "201": { content: { "application/json": { schema: { type: string } } } } } } } };
    };
    const schema = later.paths["/payments"].post.requestBody.content["application/json"].schema;
    schema.required = ["amount", "currency"];
    schema.properties.currency = { type: "string" };
    schema.properties.note = { oneOf: [{ type: "string" }] };
    later.paths["/payments"].post.responses["201"].content["application/json"].schema.type = "array";
    const result = compareOpenApiDocuments(document, later);
    expect(result.changes.some((change) => change.kind === "Required field added" && change.area === "request")).toBe(true);
    expect(result.changes.some((change) => change.area === "response")).toBe(true);
    expect(result.changes.some((change) => change.classification === "Unknown" || change.classification === "Requires review")).toBe(true);
    expect(result.limitation).toContain("oneOf");
  });

  it("labels exact field evidence separately from timing", () => {
    const activated = new Date("2026-10-19T00:00:00.000Z");
    expect(relateIncident({
      method: "POST",
      path: "/payments",
      pinnedSpecId: "rev-1",
      findingPointers: ["/amount"],
      receivedAt: activated,
      changedFields: [{ method: "POST", path: "/payments", pointer: "/amount", revisions: ["rev-1"] }],
      activatedAt: activated,
    })).toBe("Related field mismatch");
    expect(relateIncident({
      method: "GET",
      path: "/health",
      pinnedSpecId: "other",
      findingPointers: [],
      receivedAt: activated,
      changedFields: [],
      activatedAt: activated,
    })).toBe("Observed after activation");
  });
});
