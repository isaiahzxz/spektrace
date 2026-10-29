import { describe, expect, it } from "vitest";
import { isSafeOperationPathTemplate, resolveSafeOpenApiOperationPath } from "@/lib/agent-evidence/safe-path";

const uuid = "c2198617-3a8c-435d-a770-a49582c3182b";
const parsedDocument = { paths: { "/users/{userId}/profile": { get: {} }, "/payments": { post: {} } } };
const resolve = (overrides: Partial<Parameters<typeof resolveSafeOpenApiOperationPath>[0]> = {}) =>
  resolveSafeOpenApiOperationPath({
    parsedDocument, httpMethod: "GET", concreteRequestPath: `/users/${uuid}/profile`,
    scopeMatchedPath: `/users/${uuid}/profile`, ...overrides,
  });

describe("document-backed operation path export", () => {
  it("replaces a concrete UUID hint with the actual schema template", () => {
    const result = resolve();
    expect(result).toEqual({ operationPath: "/users/{userId}/profile", omissionReasonCode: null });
    expect(JSON.stringify(result)).not.toContain(uuid);
  });
  it.each([uuid, "12198617-3a8c-435d-a770-a49582c3182b"])("rejects UUID segments independently of their first character: %s", (id) => {
    expect(isSafeOperationPathTemplate(`/users/${id}/profile`).safe).toBe(false);
  });
  it("does not trust an undocumented hint even when it looks like a template", () => {
    expect(resolve({ parsedDocument: { paths: {} }, scopeMatchedPath: "/users/{userId}/profile" }).operationPath).toBeNull();
  });
  it("requires a pinned document even for a syntactically safe stored hint", () => {
    expect(resolve({ parsedDocument: null, scopeMatchedPath: "/users/{userId}/profile" }).operationPath).toBeNull();
  });
  it("does not trust a documented hint for an unrelated request", () => {
    expect(resolve({ scopeMatchedPath: "/payments" }).operationPath).toBe("/users/{userId}/profile");
  });
  it("requires the requested HTTP method to be documented", () => {
    expect(resolve({ httpMethod: "POST", scopeMatchedPath: "/users/{userId}/profile" }).operationPath).toBeNull();
  });
  it("keeps exact documented static operations", () => {
    expect(resolve({ httpMethod: "POST", concreteRequestPath: "/payments", scopeMatchedPath: "/payments" }))
      .toEqual({ operationPath: "/payments", omissionReasonCode: null });
  });
  it("accepts a matching documented template hint", () => {
    expect(resolve({ scopeMatchedPath: "/users/{userId}/profile" }).operationPath).toBe("/users/{userId}/profile");
  });
  it("omits a UUID path even if it was mistakenly registered as static", () => {
    const path = `/users/${uuid}/profile`;
    expect(resolve({ parsedDocument: { paths: { [path]: { get: {} } } } }).operationPath).toBeNull();
  });
});
