import { AGENT_EVIDENCE_LIMITS } from "@/lib/agent-evidence/limits";

const SAFE_STATIC_SEGMENT = /^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/;
const TEMPLATE_SEGMENT = /^\{[a-zA-Z][a-zA-Z0-9_-]{0,63}\}$/;

const EMAIL_LIKE = /@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const LONG_HEX = /\b[0-9a-fA-F]{32,}\b/;
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CARD_LIKE = /\b(?:\d[ -]?){13,19}\b/;
const BEARER_LIKE = /bearer\s+/i;
const CREDENTIAL_IN_PATH =
  /(password|passwd|secret|token|api[_-]?key|authorization|credential)/i;

export type SafePathResult =
  | { safe: true; path: string }
  | { safe: false; reasonCode: string };

function segmentLooksSensitive(segment: string): boolean {
  if (segment.length > AGENT_EVIDENCE_LIMITS.maxSafeIdentifierLength) {
    return true;
  }
  if (EMAIL_LIKE.test(segment) || LONG_HEX.test(segment) || UUID_LIKE.test(segment) || CARD_LIKE.test(segment)) {
    return true;
  }
  if (BEARER_LIKE.test(segment) || CREDENTIAL_IN_PATH.test(segment)) {
    return true;
  }
  if (segment.includes("=") || segment.includes("%")) {
    return true;
  }
  return false;
}

export function isSafeOperationPathTemplate(path: string): SafePathResult {
  if (!path || path.length > AGENT_EVIDENCE_LIMITS.maxOpenApiPathLength) {
    return { safe: false, reasonCode: "PATH_LENGTH_EXCEEDED" };
  }
  if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
    return { safe: false, reasonCode: "PATH_FORMAT_UNSUPPORTED" };
  }
  const segments = path.split("/").filter(Boolean);
  for (const segment of segments) {
    if (segmentLooksSensitive(segment)) {
      return { safe: false, reasonCode: "PATH_SEGMENT_SENSITIVE" };
    }
    const isTemplate = TEMPLATE_SEGMENT.test(segment);
    const isStatic = SAFE_STATIC_SEGMENT.test(segment);
    if (!isTemplate && !isStatic) {
      return { safe: false, reasonCode: "PATH_SEGMENT_UNSAFE" };
    }
  }
  return { safe: true, path };
}

function pathTemplateMatches(concrete: string, template: string): boolean {
  const concreteParts = concrete.split("/").filter(Boolean);
  const templateParts = template.split("/").filter(Boolean);
  if (concreteParts.length !== templateParts.length) {
    return false;
  }
  return templateParts.every((part, index) => {
    if (part.startsWith("{") && part.endsWith("}")) {
      return true;
    }
    return part === concreteParts[index];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolves a safe OpenAPI path template for a concrete request path.
 * Never returns the concrete path when it contains sensitive-looking segments.
 */
export function resolveSafeOpenApiOperationPath(input: {
  parsedDocument: unknown;
  httpMethod: string;
  concreteRequestPath: string;
  scopeMatchedPath: string | null | undefined;
}): { operationPath: string | null; omissionReasonCode: string | null } {
  const concreteCheck = isSafeOperationPathTemplate(input.concreteRequestPath);

  if (!isRecord(input.parsedDocument)) {
    return {
      operationPath: null,
      omissionReasonCode: concreteCheck.safe
        ? "OPENAPI_DOCUMENT_UNAVAILABLE"
        : concreteCheck.reasonCode,
    };
  }

  const paths = input.parsedDocument.paths;
  if (!isRecord(paths)) {
    return {
      operationPath: null,
      omissionReasonCode: "OPENAPI_PATHS_UNAVAILABLE",
    };
  }

  const method = input.httpMethod.toLowerCase();

  // Stored matchedPath is a hint, not proof of a documented operation.
  const scope = input.scopeMatchedPath?.trim();
  if (scope) {
    const scopeCheck = isSafeOperationPathTemplate(scope);
    const scopeItem = paths[scope];
    if (
      scopeCheck.safe && isRecord(scopeItem) && isRecord(scopeItem[method]) &&
      pathTemplateMatches(input.concreteRequestPath, scope)
    ) {
      return { operationPath: scopeCheck.path, omissionReasonCode: null };
    }
  }

  const exactPathItem = paths[input.concreteRequestPath];
  if (
    concreteCheck.safe &&
    isRecord(exactPathItem) &&
    isRecord(exactPathItem[method])
  ) {
    return { operationPath: concreteCheck.path, omissionReasonCode: null };
  }

  const candidates: string[] = [];
  for (const template of Object.keys(paths)) {
    if (!pathTemplateMatches(input.concreteRequestPath, template)) {
      continue;
    }
    const pathItem = paths[template];
    if (!isRecord(pathItem) || !isRecord(pathItem[method])) {
      continue;
    }
    candidates.push(template);
  }

  if (candidates.length === 0) {
    const omissionReasonCode =
      concreteCheck.safe === false
        ? concreteCheck.reasonCode
        : "OPERATION_TEMPLATE_NOT_FOUND";
    return {
      operationPath: null,
      omissionReasonCode,
    };
  }

  candidates.sort((a, b) => b.length - a.length);
  for (const template of candidates) {
    const check = isSafeOperationPathTemplate(template);
    if (check.safe) {
      return { operationPath: check.path, omissionReasonCode: null };
    }
  }

  return { operationPath: null, omissionReasonCode: "OPERATION_TEMPLATE_UNSAFE" };
}

const SAFE_POINTER_SEGMENT = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export function sanitizeJsonPointer(pointer: string): {
  pointer: string | null;
  omitted: boolean;
  reasonCode: string | null;
} {
  if (!pointer || pointer.length > AGENT_EVIDENCE_LIMITS.maxJsonPointerLength) {
    return { pointer: null, omitted: true, reasonCode: "JSON_POINTER_TOO_LONG" };
  }
  if (pointer === "/") {
    return { pointer: "/", omitted: false, reasonCode: null };
  }
  if (!pointer.startsWith("/")) {
    return { pointer: null, omitted: true, reasonCode: "JSON_POINTER_INVALID" };
  }

  const segments: string[] = [];
  for (const rawSegment of pointer.split("/").slice(1)) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!SAFE_POINTER_SEGMENT.test(segment) || segmentLooksSensitive(segment)) {
      return { pointer: null, omitted: true, reasonCode: "JSON_POINTER_SEGMENT_UNSAFE" };
    }
    segments.push(rawSegment);
  }

  return { pointer: `/${segments.join("/")}`, omitted: false, reasonCode: null };
}

export function sanitizeSchemaRulePath(path: string): {
  path: string | null;
  omitted: boolean;
  reasonCode: string | null;
} {
  if (!path || path.length > AGENT_EVIDENCE_LIMITS.maxSchemaRulePathLength) {
    return { path: null, omitted: true, reasonCode: "SCHEMA_RULE_PATH_TOO_LONG" };
  }
  if (!path.startsWith("#/")) {
    return { path: null, omitted: true, reasonCode: "SCHEMA_RULE_PATH_INVALID" };
  }
  const tail = path.slice(2);
  const segments = tail.split("/").filter(Boolean);
  for (const segment of segments) {
    const decoded = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (
      decoded === "examples" ||
      decoded === "example" ||
      decoded === "default" ||
      decoded === "const"
    ) {
      return { path: null, omitted: true, reasonCode: "SCHEMA_RULE_PATH_SENSITIVE" };
    }
    if (!SAFE_POINTER_SEGMENT.test(decoded)) {
      return { path: null, omitted: true, reasonCode: "SCHEMA_RULE_PATH_SEGMENT_UNSAFE" };
    }
  }
  return { path, omitted: false, reasonCode: null };
}

export function sanitizePropertyName(name: string): string | null {
  if (!name || name.length > AGENT_EVIDENCE_LIMITS.maxSafeIdentifierLength) {
    return null;
  }
  if (!SAFE_POINTER_SEGMENT.test(name) || segmentLooksSensitive(name)) {
    return null;
  }
  return name;
}
