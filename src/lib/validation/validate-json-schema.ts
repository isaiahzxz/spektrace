import {
  compileSupportedSchema,
  createAjv,
  mapAjvErrors,
  UnsupportedSchemaError,
} from "@/lib/validation/ajv";

export type ValidationEvidenceItem = {
  jsonPointer: string;
  keyword: string;
  schemaPath: string;
  message: string;
  expected?: string;
  observedType?: string;
  missingProperty?: string;
  additionalProperty?: string;
  allowedValues?: Array<string | number | boolean | null>;
};

export type JsonSchemaValidationResult =
  | { status: "passed"; evidence: ValidationEvidenceItem[] }
  | { status: "mismatch"; evidence: ValidationEvidenceItem[] }
  | { status: "unsupported"; reason: string }
  | { status: "error"; reason: string };

const sharedAjv = createAjv();

function observedJsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function resolveJsonPointer(
  root: unknown,
  pointer: string,
): { found: true; value: unknown } | { found: false } {
  if (pointer === "" || pointer === "/") {
    return { found: true, value: root };
  }
  let current: unknown = root;
  for (const rawSegment of pointer.split("/").slice(1)) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (current === null || typeof current !== "object") {
      return { found: false };
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return { found: false };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

export function validateJsonSchemaPayload(
  schema: Record<string, unknown>,
  payload: unknown,
): JsonSchemaValidationResult {
  try {
    const validate = compileSupportedSchema(sharedAjv, schema);
    const payloadCopy = structuredClone(payload);
    const valid = validate(payloadCopy);

    if (valid) {
      return { status: "passed", evidence: [] };
    }

    const evidence = mapAjvErrors(validate.errors).map((item) => {
      const pointer = item.jsonPointer === "" ? "/" : item.jsonPointer;
      const resolved = resolveJsonPointer(payloadCopy, pointer);
      const observedType = resolved.found ? observedJsonType(resolved.value) : undefined;
      return { ...item, jsonPointer: pointer, observedType };
    });

    return { status: "mismatch", evidence };
  } catch (error) {
    if (error instanceof UnsupportedSchemaError) {
      return { status: "unsupported", reason: error.message };
    }
    return {
      status: "error",
      reason: error instanceof Error ? error.message : "Unknown validation error",
    };
  }
}
