import { describe, expect, it } from "vitest";
import {
  classifyHttp429,
  parseGatewayHttpFailure,
} from "@/lib/investigation/inference/adapters/gateway-error-diagnostics";

function responseFrom(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("gateway error diagnostics", () => {
  it("classifies temporary throttling when Retry-After is present", async () => {
    const parsed = await parseGatewayHttpFailure(
      responseFrom(429, { error: { type: "rate_limit", message: "Too many requests" } }, {
        "retry-after": "30",
        "x-request-id": "req-abc-123",
      }),
    );
    expect(parsed.failureCode).toBe("GATEWAY_HTTP_429_TEMPORARY");
    expect(parsed.retryable).toBe(true);
    expect(parsed.diagnostics.classification).toBe("temporary_throttling");
    expect(parsed.diagnostics.retryAfterSeconds).toBe(30);
    expect(parsed.diagnostics.requestId).toBe("req-abc-123");
    expect(parsed.diagnostics.summary).toContain("HTTP 429");
    expect(parsed.diagnostics.summary).not.toMatch(/sk-[a-z]/i);
  });

  it("classifies quota or account restrictions from provider codes", async () => {
    const classification = classifyHttp429({
      providerErrorType: "insufficient_quota",
      providerErrorCode: "billing_hard_limit_reached",
      message: "You exceeded your current quota, please check your plan and billing details.",
      retryAfterSeconds: null,
    });
    expect(classification).toBe("quota_or_account_restriction");

    const parsed = await parseGatewayHttpFailure(
      responseFrom(429, {
        error: {
          type: "insufficient_quota",
          code: "billing_hard_limit_reached",
          message: "You exceeded your current quota, please check your plan and billing details.",
        },
      }),
    );
    expect(parsed.failureCode).toBe("GATEWAY_HTTP_429_QUOTA");
    expect(parsed.retryable).toBe(false);
    expect(parsed.diagnostics.classification).toBe("quota_or_account_restriction");
  });

  it("classifies model or access restrictions", async () => {
    const parsed = await parseGatewayHttpFailure(
      responseFrom(429, {
        error: {
          type: "invalid_request_error",
          code: "model_not_found",
          message: "The model `openai/gpt-4.1-mini` does not exist or you do not have access.",
        },
      }),
    );
    expect(parsed.failureCode).toBe("GATEWAY_HTTP_429_ACCESS");
    expect(parsed.retryable).toBe(false);
    expect(parsed.diagnostics.classification).toBe("model_or_access_restriction");
  });

  it("preserves unknown when 429 body is empty", async () => {
    const parsed = await parseGatewayHttpFailure(new Response(null, { status: 429 }));
    expect(parsed.failureCode).toBe("GATEWAY_HTTP_429_UNKNOWN");
    expect(parsed.retryable).toBe(false);
    expect(parsed.diagnostics.classification).toBe("unknown");
    expect(parsed.diagnostics.providerErrorCode).toBeNull();
    expect(parsed.diagnostics.summary).toContain("cause not established");
  });

  it("redacts token-like substrings from sanitized summaries", async () => {
    const parsed = await parseGatewayHttpFailure(
      responseFrom(429, {
        error: { message: "Unauthorized key sk-th-abcdefghijklmnopqrstuvwxyz1234567890" },
      }),
    );
    expect(parsed.diagnostics.summary).toContain("[REDACTED_TOKEN]");
    expect(parsed.diagnostics.summary).not.toContain("sk-th-abcdefghijklmnopqrstuvwxyz");
  });
});
