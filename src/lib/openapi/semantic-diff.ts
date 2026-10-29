const METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "trace"] as const;
const CONSTRAINTS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems", "pattern", "format", "multipleOf"] as const;

export type ChangeClass = "Requires review" | "Unknown" | "Addition";

export type SemanticChange = {
  area: "request" | "response" | "operation";
  kind: string;
  subject: string;
  detail: string;
  classification: ChangeClass;
};

type FieldShape = {
  required: boolean;
  type: string;
  enumValues: string | null;
  constraints: string;
  ambiguous: boolean;
};

type OperationShape = {
  key: string;
  method: string;
  path: string;
  requestAmbiguous: boolean;
  fields: Map<string, FieldShape>;
  responses: Map<string, string>;
  responseAmbiguous: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveLocal(document: Record<string, unknown>, node: unknown, depth: number): unknown {
  if (!isRecord(node) || typeof node.$ref !== "string") return node;
  if (!node.$ref.startsWith("#/") || depth > 6) return { ambiguous: true };
  const parts = node.$ref.slice(2).split("/").map((part) => decodeURIComponent(part.replace(/~1/g, "/").replace(/~0/g, "~")));
  let current: unknown = document;
  for (const part of parts) {
    if (!isRecord(current) || !(part in current)) return { ambiguous: true };
    current = current[part];
  }
  return resolveLocal(document, current, depth + 1);
}

function typeLabel(schema: Record<string, unknown>) {
  if (Array.isArray(schema.type)) return schema.type.map(String).sort().join("|");
  if (typeof schema.type === "string") return schema.type;
  return "unknown";
}

function constraintLabel(schema: Record<string, unknown>) {
  return CONSTRAINTS.flatMap((key) => (key in schema ? [`${key}=${JSON.stringify(schema[key])}`] : [])).join(",");
}

function enumLabel(schema: Record<string, unknown>) {
  if (!Array.isArray(schema.enum)) return null;
  return schema.enum.map((value) => JSON.stringify(value)).sort().join(",");
}

function readFields(document: Record<string, unknown>, schema: unknown, prefix: string, required: Set<string>, into: Map<string, FieldShape>, depth: number): boolean {
  const resolved = resolveLocal(document, schema, 0);
  if (!isRecord(resolved) || resolved.ambiguous === true) return true;
  if ("oneOf" in resolved || "anyOf" in resolved || "allOf" in resolved || "not" in resolved) return true;
  if (depth > 4) return true;
  const ownRequired = new Set(Array.isArray(resolved.required) ? resolved.required.filter((item): item is string => typeof item === "string") : []);
  if (isRecord(resolved.properties)) {
    for (const [name, child] of Object.entries(resolved.properties)) {
      const pointer = `${prefix}/${name}`;
      const childResolved = resolveLocal(document, child, 0);
      if (!isRecord(childResolved) || childResolved.ambiguous === true || "oneOf" in childResolved || "anyOf" in childResolved || "allOf" in childResolved) {
        into.set(pointer, { required: ownRequired.has(name) || required.has(name), type: "unknown", enumValues: null, constraints: "", ambiguous: true });
        continue;
      }
      into.set(pointer, {
        required: ownRequired.has(name) || required.has(name),
        type: typeLabel(childResolved),
        enumValues: enumLabel(childResolved),
        constraints: constraintLabel(childResolved),
        ambiguous: false,
      });
      if (childResolved.type === "object") {
        if (readFields(document, childResolved, pointer, ownRequired, into, depth + 1)) {
          const current = into.get(pointer);
          if (current) current.ambiguous = true;
        }
      }
    }
  }
  return false;
}

function requestSchema(document: Record<string, unknown>, operation: Record<string, unknown>) {
  const body = resolveLocal(document, operation.requestBody, 0);
  if (!isRecord(body)) return null;
  const content = isRecord(body.content) ? body.content : null;
  const json = content && isRecord(content["application/json"]) ? content["application/json"] : null;
  if (!json || !("schema" in json)) return null;
  return json.schema;
}

function responseSummary(document: Record<string, unknown>, operation: Record<string, unknown>) {
  const responses = new Map<string, string>();
  let ambiguous = false;
  const block = resolveLocal(document, operation.responses, 0);
  if (!isRecord(block)) return { responses, ambiguous: true };
  for (const [status, value] of Object.entries(block)) {
    const response = resolveLocal(document, value, 0);
    if (!isRecord(response)) {
      responses.set(status, "unknown");
      ambiguous = true;
      continue;
    }
    const content = isRecord(response.content) ? response.content["application/json"] : null;
    if (!isRecord(content) || !("schema" in content)) {
      responses.set(status, "no json schema");
      continue;
    }
    const schema = resolveLocal(document, content.schema, 0);
    if (!isRecord(schema) || schema.ambiguous === true) {
      responses.set(status, "unknown");
      ambiguous = true;
      continue;
    }
    responses.set(status, `${typeLabel(schema)}${enumLabel(schema) ? ` enum ${enumLabel(schema)}` : ""}`);
  }
  return { responses, ambiguous };
}

export function extractOperations(document: unknown): OperationShape[] {
  if (!isRecord(document) || !isRecord(document.paths)) return [];
  const operations: OperationShape[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    let pathItem: unknown = item;
    if (isRecord(item) && typeof item.$ref === "string") pathItem = resolveLocal(document, item, 0);
    if (!isRecord(pathItem)) continue;
    for (const method of METHODS) {
      const operation = pathItem[method];
      if (!isRecord(operation)) continue;
      const fields = new Map<string, FieldShape>();
      const schema = requestSchema(document, operation);
      const requestAmbiguous = schema ? readFields(document, schema, "", new Set(), fields, 0) : false;
      const responses = responseSummary(document, operation);
      operations.push({
        key: `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        path,
        requestAmbiguous,
        fields,
        responses: responses.responses,
        responseAmbiguous: responses.ambiguous,
      });
    }
  }
  return operations;
}

export function compareOpenApiDocuments(left: unknown, right: unknown): { changes: SemanticChange[]; truncated: boolean; limitation: string } {
  const before = new Map(extractOperations(left).map((operation) => [operation.key, operation]));
  const after = new Map(extractOperations(right).map((operation) => [operation.key, operation]));
  const changes: SemanticChange[] = [];
  const push = (change: SemanticChange) => {
    if (changes.length < 200) changes.push(change);
  };
  for (const [key, operation] of after) {
    if (!before.has(key)) {
      push({ area: "operation", kind: "Operation added", subject: key, detail: "This operation is present only in the later revision.", classification: "Addition" });
      continue;
    }
    const previous = before.get(key)!;
    if (operation.requestAmbiguous || previous.requestAmbiguous) {
      push({ area: "request", kind: "Request schema", subject: key, detail: "A request schema uses a construct this comparison does not fully read.", classification: "Unknown" });
    }
    const fieldNames = new Set([...previous.fields.keys(), ...operation.fields.keys()]);
    for (const field of fieldNames) {
      const from = previous.fields.get(field);
      const to = operation.fields.get(field);
      if (!from && to) {
        push({ area: "request", kind: to.required ? "Required field added" : "Request field added", subject: `${key} ${field}`, detail: to.ambiguous ? "The field schema is only partly read." : `Type ${to.type}.`, classification: to.required || to.ambiguous ? "Requires review" : "Addition" });
      } else if (from && !to) {
        push({ area: "request", kind: "Request field removed", subject: `${key} ${field}`, detail: from.required ? "The field was required." : "The field was optional.", classification: "Requires review" });
      } else if (from && to) {
        if (from.ambiguous || to.ambiguous) {
          push({ area: "request", kind: "Request field", subject: `${key} ${field}`, detail: "The field schema is only partly read.", classification: "Unknown" });
          continue;
        }
        if (from.required !== to.required) {
          push({ area: "request", kind: "Required change", subject: `${key} ${field}`, detail: to.required ? "The field became required." : "The field is no longer required.", classification: "Requires review" });
        }
        if (from.type !== to.type) {
          push({ area: "request", kind: "Type change", subject: `${key} ${field}`, detail: `${from.type} to ${to.type}.`, classification: "Requires review" });
        }
        if (from.enumValues !== to.enumValues) {
          push({ area: "request", kind: "Enum change", subject: `${key} ${field}`, detail: "The allowed values differ.", classification: "Requires review" });
        }
        if (from.constraints !== to.constraints) {
          push({ area: "request", kind: "Constraint change", subject: `${key} ${field}`, detail: `${from.constraints || "none"} to ${to.constraints || "none"}.`, classification: "Requires review" });
        }
      }
    }
    if (operation.responseAmbiguous || previous.responseAmbiguous) {
      push({ area: "response", kind: "Response schema", subject: key, detail: "A response schema uses a construct this comparison does not fully read.", classification: "Unknown" });
    }
    const statuses = new Set([...previous.responses.keys(), ...operation.responses.keys()]);
    for (const status of statuses) {
      const from = previous.responses.get(status);
      const to = operation.responses.get(status);
      if (from === to) continue;
      push({
        area: "response",
        kind: !from ? "Response added" : !to ? "Response removed" : "Response change",
        subject: `${key} ${status}`,
        detail: `${from ?? "absent"} to ${to ?? "absent"}.`,
        classification: "Requires review",
      });
    }
  }
  for (const key of before.keys()) {
    if (!after.has(key)) {
      push({ area: "operation", kind: "Operation removed", subject: key, detail: "This operation is present only in the earlier revision.", classification: "Requires review" });
    }
  }
  return {
    changes,
    truncated: changes.length >= 200,
    limitation: "Comparison reads OpenAPI 3.1 path operations, local #/ references, JSON request properties, required flags, type, enum, and a fixed constraint list. It does not treat YAML text as a change. oneOf, anyOf, allOf, remote references, callbacks, and links are Unknown or Requires review rather than a complete breaking-change verdict.",
  };
}
