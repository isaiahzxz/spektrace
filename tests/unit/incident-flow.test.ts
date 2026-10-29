import { describe, expect, it, vi, afterEach } from "vitest";
import { verifyInternalApiToken } from "@/lib/internal-config";
import { redactSanitizedRequestBody } from "@/lib/redaction/sanitize-body";
import { incidentSubmissionSchema } from "@/lib/validation/incident-envelope";
import { resolveOpenApiJsonRequestBodySchema } from "@/lib/validation/resolve-openapi-request-schema";
import { validateJsonSchemaPayload } from "@/lib/validation/validate-json-schema";

describe("internal API token verification", () => {
  it("uses constant-time comparison semantics", () => {
    const token = "a".repeat(64);
    expect(verifyInternalApiToken(token, token)).toBe(true);
    expect(verifyInternalApiToken(token, `${token}x`)).toBe(false);
    expect(verifyInternalApiToken(null, token)).toBe(false);
  });
});

describe("incident submission envelope", () => {
  it("rejects unknown fields and invalid status codes", () => {
    const valid = incidentSubmissionSchema.safeParse({
      source: "WEBHOOK",
      sourceEventId: "evt-1",
      apiKey: "payments-api",
      httpMethod: "post",
      requestPath: "/payments",
      statusCode: 400,
      occurredAt: new Date().toISOString(),
      sanitizedRequestBody: { amount: 12.5 },
    });
    expect(valid.success).toBe(true);

    const base = {
      source: "WEBHOOK" as const,
      sourceEventId: "evt-1",
      apiKey: "payments-api",
      httpMethod: "post",
      requestPath: "/payments",
      statusCode: 400,
      occurredAt: new Date().toISOString(),
      sanitizedRequestBody: { amount: 12.5 },
    };
    const withQuery = incidentSubmissionSchema.safeParse({
      ...base,
      requestPath: "/payments?x=1",
    });
    expect(withQuery.success).toBe(false);

    const badStatus = incidentSubmissionSchema.safeParse({
      ...base,
      statusCode: 500,
    });
    expect(badStatus.success).toBe(false);
  });
});

describe("redaction", () => {
  it("redacts credential-like keys and blocks conclusive validation", () => {
    const result = redactSanitizedRequestBody({
      amount: 12.5,
      apiKey: "secret-value",
    });
    expect(result.redactedPaths).toContain("/apiKey");
    expect(result.validationBlocked).toBe(true);
    expect((result.value as { apiKey: string }).apiKey).toBe("[REDACTED]");
  });

  it("does not pass through nested content when depth limits are exceeded", () => {
    let nested: Record<string, unknown> = { pan: "4111111111111111" };
    for (let i = 0; i < 12; i += 1) {
      nested = { nested };
    }
    const result = redactSanitizedRequestBody(nested);
    expect(result.incomplete).toBe(true);
    expect(JSON.stringify(result.value)).not.toContain("4111111111111111");
  });
});

describe("openapi validation scope", () => {
  const schema = {
    type: "object",
    required: ["amount"],
    properties: { amount: { type: "integer" } },
  };

  it("resolves demo inline json body schema", () => {
    const resolved = resolveOpenApiJsonRequestBodySchema({
      parsedDocument: {
        openapi: "3.1.0",
        paths: {
          "/payments": {
            post: {
              requestBody: {
                content: { "application/json": { schema } },
              },
            },
          },
        },
      },
      openApiVersion: "3.1.0",
      apiSpecId: "spec-1",
      sourceSha256: "sha",
      httpMethod: "POST",
      requestPath: "/payments",
    });
    expect(resolved.status).toBe("resolved");
  });

  it("flags fractional amount mismatch without mutating payload", () => {
    const payload = { amount: 12.5 };
    const before = structuredClone(payload);
    const result = validateJsonSchemaPayload(schema, payload);
    expect(result.status).toBe("mismatch");
    expect(payload).toEqual(before);
  });

  it("passes integer amount", () => {
    const result = validateJsonSchemaPayload(schema, { amount: 10 });
    expect(result.status).toBe("passed");
  });
});

describe("requireInternalPilotConfig", () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
    vi.resetModules();
  });

  it("requires explicit pilot settings", async () => {
    delete process.env.SPEKTRACE_INTERNAL_API_TOKEN;
    delete process.env.SPEKTRACE_INTERNAL_WORKSPACE_ID;
    const { requireInternalPilotConfig } = await import("@/lib/internal-config");
    expect(() => requireInternalPilotConfig()).toThrow();
  });
});
