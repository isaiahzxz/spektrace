import Ajv2020 from "ajv/dist/2020";
import { type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

/**
 * Supported dialect for request-body validation in this foundation phase.
 * OpenAPI operation selection and dialect conversion are deferred.
 */
export const SUPPORTED_JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

export function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  });
  addFormats(ajv);
  return ajv;
}

export function compileSupportedSchema(
  ajv: Ajv2020,
  schema: Record<string, unknown>,
): ValidateFunction {
  if (schema.$schema && schema.$schema !== SUPPORTED_JSON_SCHEMA_DIALECT) {
    throw new UnsupportedSchemaError(
      `Unsupported JSON Schema dialect: ${String(schema.$schema)}`,
    );
  }
  const withDialect = {
    $schema: SUPPORTED_JSON_SCHEMA_DIALECT,
    ...schema,
  };
  try {
    return ajv.compile(withDialect);
  } catch (error) {
    throw new UnsupportedSchemaError(
      error instanceof Error ? error.message : "Invalid JSON Schema",
    );
  }
}

export class UnsupportedSchemaError extends Error {
  readonly code = "UNSUPPORTED_SCHEMA" as const;

  constructor(message: string) {
    super(message);
    this.name = "UnsupportedSchemaError";
  }
}

export function mapAjvErrors(errors: ErrorObject[] | null | undefined) {
  return (errors ?? []).map((err) => ({
    jsonPointer: err.instancePath || "/",
    keyword: err.keyword,
    schemaPath: err.schemaPath,
    message: err.message ?? "Validation error",
    expected: formatExpected(err),
    observedType: undefined,
    missingProperty: stringParam(err, "missingProperty"),
    additionalProperty: stringParam(err, "additionalProperty"),
    allowedValues: allowedValuesParam(err),
  }));
}

function stringParam(err: ErrorObject, name: string): string | undefined {
  const value = (err.params as Record<string, unknown> | undefined)?.[name];
  return typeof value === "string" ? value : undefined;
}

/** Allowed values come from the schema, never from the request payload. */
function allowedValuesParam(err: ErrorObject): Array<string | number | boolean | null> | undefined {
  const params = err.params as Record<string, unknown> | undefined;
  const raw =
    err.keyword === "enum"
      ? params?.allowedValues
      : err.keyword === "const"
        ? [params?.allowedValue]
        : undefined;
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const scalars = raw.filter(
    (v): v is string | number | boolean | null =>
      v === null || ["string", "number", "boolean"].includes(typeof v),
  );
  return scalars.length === raw.length ? scalars.slice(0, 20) : undefined;
}

function formatExpected(err: ErrorObject): string | undefined {
  if (err.keyword === "type" && Array.isArray(err.params?.type)) {
    return err.params.type.join(" | ");
  }
  if (typeof err.params?.type === "string") {
    return err.params.type;
  }
  return undefined;
}
