export type OpenApiResolutionResult =
  | {
      status: "resolved";
      openApiVersion: string;
      matchedPath: string;
      matchedMethod: string;
      requestBodySchema: Record<string, unknown>;
      sourceSha256: string;
      apiSpecId: string;
    }
  | { status: "unsupported"; reasonCode: string; reasonMessage: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasRef(node: unknown): boolean {
  if (!isRecord(node)) {
    return false;
  }
  if ("$ref" in node) {
    return true;
  }
  return Object.values(node).some((child) => hasRef(child));
}

export function resolveOpenApiJsonRequestBodySchema(input: {
  parsedDocument: unknown;
  openApiVersion: string;
  apiSpecId: string;
  sourceSha256: string;
  httpMethod: string;
  requestPath: string;
}): OpenApiResolutionResult {
  const version = input.openApiVersion.trim();
  if (!version.startsWith("3.1")) {
    return {
      status: "unsupported",
      reasonCode: "OPENAPI_VERSION_UNSUPPORTED",
      reasonMessage: "Only OpenAPI 3.1 specifications are supported in this milestone.",
    };
  }

  if (!isRecord(input.parsedDocument)) {
    return {
      status: "unsupported",
      reasonCode: "OPENAPI_DOCUMENT_INVALID",
      reasonMessage: "Stored OpenAPI document is not a JSON object.",
    };
  }

  const paths = input.parsedDocument.paths;
  if (!isRecord(paths)) {
    return {
      status: "unsupported",
      reasonCode: "OPENAPI_PATHS_MISSING",
      reasonMessage: "OpenAPI paths object is missing.",
    };
  }

  if (input.requestPath.includes("{") || input.requestPath.includes("}")) {
    return {
      status: "unsupported",
      reasonCode: "PATH_TEMPLATE_UNSUPPORTED",
      reasonMessage: "Templated request paths are not supported yet.",
    };
  }

  const pathItem = paths[input.requestPath];
  if (!isRecord(pathItem)) {
    return {
      status: "unsupported",
      reasonCode: "OPERATION_NOT_FOUND",
      reasonMessage: `No OpenAPI path entry exists for ${input.requestPath}.`,
    };
  }

  const method = input.httpMethod.toLowerCase();
  const operation = pathItem[method];
  if (!isRecord(operation)) {
    return {
      status: "unsupported",
      reasonCode: "OPERATION_NOT_FOUND",
      reasonMessage: `No ${input.httpMethod} operation exists for ${input.requestPath}.`,
    };
  }

  const requestBody = operation.requestBody;
  if (!isRecord(requestBody)) {
    return {
      status: "unsupported",
      reasonCode: "REQUEST_BODY_MISSING",
      reasonMessage: "This operation does not declare a request body to validate.",
    };
  }

  const content = requestBody.content;
  if (!isRecord(content) || !isRecord(content["application/json"])) {
    return {
      status: "unsupported",
      reasonCode: "JSON_BODY_UNSUPPORTED",
      reasonMessage: "Only inline application/json request bodies are supported.",
    };
  }

  const schema = content["application/json"].schema;
  if (!isRecord(schema)) {
    return {
      status: "unsupported",
      reasonCode: "REQUEST_SCHEMA_MISSING",
      reasonMessage: "application/json request body schema is missing.",
    };
  }

  if (hasRef(schema) || hasRef(requestBody) || hasRef(operation)) {
    return {
      status: "unsupported",
      reasonCode: "REFERENCE_UNSUPPORTED",
      reasonMessage: "JSON Schema $ref resolution is not implemented in this milestone.",
    };
  }

  return {
    status: "resolved",
    openApiVersion: version,
    matchedPath: input.requestPath,
    matchedMethod: input.httpMethod.toUpperCase(),
    requestBodySchema: schema,
    sourceSha256: input.sourceSha256,
    apiSpecId: input.apiSpecId,
  };
}
