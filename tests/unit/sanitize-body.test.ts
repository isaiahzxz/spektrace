import { describe, expect, it } from "vitest";
import {
  MAX_DEPTH,
  MAX_KEYS,
  OMITTED_DEPTH_LIMIT,
  OMITTED_KEY_LIMIT,
  redactSanitizedRequestBody,
} from "@/lib/redaction/sanitize-body";

describe("redactSanitizedRequestBody limits", () => {
  it("replaces content beyond the depth limit and blocks validation", () => {
    let nested: Record<string, unknown> = { leaf: "visible" };
    for (let i = 0; i < MAX_DEPTH + 2; i += 1) {
      nested = { child: nested };
    }

    const result = redactSanitizedRequestBody(nested);
    expect(result.validationBlocked).toBe(true);
    expect(result.incomplete).toBe(true);
    expect(JSON.stringify(result.value)).toContain(OMITTED_DEPTH_LIMIT);
    expect(result.redactedPaths.length).toBeGreaterThan(0);
  });

  it("handles deeply nested arrays consistently", () => {
    let nested: unknown[] = ["tail"];
    for (let i = 0; i < MAX_DEPTH + 2; i += 1) {
      nested = [nested];
    }

    const result = redactSanitizedRequestBody(nested);
    expect(result.validationBlocked).toBe(true);
    expect(result.incomplete).toBe(true);
    expect(JSON.stringify(result.value)).toContain(OMITTED_DEPTH_LIMIT);
  });

  it("marks key-budget exhaustion without passing through unchecked keys", () => {
    const input: Record<string, unknown> = {};
    for (let i = 0; i < MAX_KEYS + 3; i += 1) {
      input[`field${i}`] = `value-${i}`;
    }

    const result = redactSanitizedRequestBody(input);
    expect(result.validationBlocked).toBe(true);
    expect(result.incomplete).toBe(true);
    const value = result.value as Record<string, unknown>;
    expect(value[OMITTED_KEY_LIMIT]).toBe(OMITTED_KEY_LIMIT);
    expect(Object.keys(value).length).toBeLessThanOrEqual(MAX_KEYS + 1);
    expect(result.redactedPaths.some((p) => p.includes(OMITTED_KEY_LIMIT))).toBe(true);
  });

  it("still redacts credential-like keys", () => {
    const result = redactSanitizedRequestBody({
      amount: 10,
      apiKey: "super-secret-key-value",
    });
    expect(result.validationBlocked).toBe(true);
    expect((result.value as { apiKey: string }).apiKey).toBe("[REDACTED]");
  });
});
