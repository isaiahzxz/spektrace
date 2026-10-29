import { createHash } from "node:crypto";

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "trace"] as const;
const MAX_SPEC_BYTES = 256_000;

export class OpenApiImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenApiImportError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sha256Text(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/** Reject remote and non-local references. Local #/ pointers are allowed and not fetched. */
export function assertLocalRefsOnly(value: unknown, seen = new Set<unknown>()) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry) => assertLocalRefsOnly(entry, seen));
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.$ref === "string" && !record.$ref.startsWith("#/")) {
    throw new OpenApiImportError("Remote or non-local $ref values are not accepted. Use a local #/ reference or inline the schema.");
  }
  Object.values(record).forEach((entry) => assertLocalRefsOnly(entry, seen));
}

export function parseOpenApiSource(sourceText: string) {
  if (sourceText.length > MAX_SPEC_BYTES) {
    throw new OpenApiImportError("Specification is larger than 256 KB.");
  }
  const trimmed = sourceText.trim();
  if (trimmed.startsWith("openapi:") || trimmed.startsWith("---")) {
    throw new OpenApiImportError("Upload OpenAPI as JSON. YAML is not accepted.");
  }
  let document: unknown;
  try {
    document = JSON.parse(sourceText);
  } catch {
    throw new OpenApiImportError("Specification is not valid JSON.");
  }
  if (!isRecord(document)) {
    throw new OpenApiImportError("Specification must be a JSON object.");
  }
  const openapi = typeof document.openapi === "string" ? document.openapi : "";
  if (!openapi.startsWith("3.1")) {
    throw new OpenApiImportError("Only OpenAPI 3.1 documents are accepted.");
  }
  const info = isRecord(document.info) ? document.info : null;
  const title = info && typeof info.title === "string" ? info.title.trim() : "";
  const version = info && typeof info.version === "string" ? info.version.trim() : "";
  if (!title || title.length > 120) {
    throw new OpenApiImportError("info.title is required and must be 120 characters or fewer.");
  }
  if (!version || version.length > 64) {
    throw new OpenApiImportError("info.version is required and must be 64 characters or fewer.");
  }
  if (!isRecord(document.paths)) {
    throw new OpenApiImportError("paths must be an object.");
  }
  assertLocalRefsOnly(document);
  return { document, openApiVersion: openapi, title, version, sourceSha256: sha256Text(sourceText) };
}

function resolveLocal(document: Record<string, unknown>, ref: string, depth: number): unknown {
  if (!ref.startsWith("#/") || depth > 8) return undefined;
  const parts = ref.slice(2).split("/").map((part) => decodeURIComponent(part.replace(/~1/g, "/").replace(/~0/g, "~")));
  let current: unknown = document;
  for (const part of parts) {
    if (!isRecord(current) || !(part in current)) return undefined;
    current = current[part];
  }
  if (isRecord(current) && typeof current.$ref === "string") {
    return resolveLocal(document, current.$ref, depth + 1);
  }
  return current;
}

export function countDocumentedOperations(document: unknown) {
  if (!isRecord(document) || !isRecord(document.paths)) {
    return { operations: 0, unresolvedPaths: 0 };
  }
  let operations = 0;
  let unresolvedPaths = 0;
  for (const item of Object.values(document.paths)) {
    let pathItem = item;
    if (isRecord(item) && typeof item.$ref === "string") {
      if (!item.$ref.startsWith("#/")) {
        unresolvedPaths += 1;
        continue;
      }
      pathItem = resolveLocal(document, item.$ref, 0);
      if (!isRecord(pathItem)) {
        unresolvedPaths += 1;
        continue;
      }
    }
    if (!isRecord(pathItem)) continue;
    for (const method of METHODS) {
      if (isRecord(pathItem[method])) operations += 1;
    }
  }
  return { operations, unresolvedPaths };
}
