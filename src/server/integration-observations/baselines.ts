import type { PrismaClient } from "@/generated/prisma/client";
import { appendAuditLog } from "@/lib/audit/append-audit-log";
import {
  baselineCommandSchema,
  baselineScope,
  baselineShapeSchema,
  canonical,
  digest,
  jsonTypeSchema,
  observationSchema,
  type BaselineCommand,
  type BaselineShape,
} from "@/lib/integration-observations/contract";
import { IntegrationScopeError, lockIntegrationKeys } from "@/server/integration-observations/ingest";

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function contractShape(
  document: unknown,
  command: Extract<BaselineCommand, { action: "contract" }>,
): BaselineShape {
  if (
    !record(document) ||
    !String(document.openapi).startsWith("3.1") ||
    !record(document.paths)
  )
    throw new IntegrationScopeError();
  const path = document.paths[command.operation.path],
    method = command.operation.method.toLowerCase();
  if (!record(path) || !record(path[method])) throw new IntegrationScopeError();
  const op = path[method];
  const responses = op.responses;
  if (!record(responses) || !record(responses[String(command.statusCode)]))
    throw new IntegrationScopeError();
  const response = responses[String(command.statusCode)];
  if (
    !record(response) ||
    !record(response.content) ||
    !record(response.content["application/json"])
  )
    throw new IntegrationScopeError();
  const schema = response.content["application/json"].schema;
  if (
    !record(schema) ||
    ["$ref", "oneOf", "anyOf", "allOf"].some((key) => key in schema)
  )
    throw new IntegrationScopeError();
  const rootType = jsonTypeSchema.parse(schema.type);
  const fields = command.pointers
    .slice()
    .sort()
    .map((pointer) => {
      let node: Record<string, unknown> = schema,
        required = true;
      for (const key of pointer.slice(1).split("/")) {
        if (
          node.type !== "object" ||
          !record(node.properties) ||
          !record(node.properties[key]) ||
          ["$ref", "oneOf", "anyOf", "allOf"].some((k) => k in node)
        )
          throw new IntegrationScopeError();
        required =
          required &&
          Array.isArray(node.required) &&
          node.required.includes(key);
        node = node.properties[key];
      }
      if (["$ref", "oneOf", "anyOf", "allOf"].some((key) => key in node))
        throw new IntegrationScopeError();
      const type = jsonTypeSchema.parse(node.type),
        elementTypes =
          type === "array"
            ? record(node.items)
              ? [jsonTypeSchema.parse(node.items.type)]
              : undefined
            : undefined;
      if (type === "array" && !elementTypes) throw new IntegrationScopeError();
      return {
        pointer,
        presence: "present" as const,
        type,
        required,
        ...(elementTypes ? { elementTypes } : {}),
      };
    });
  return baselineShapeSchema.parse({ version: 1, rootType, fields });
}
export async function manageResponseBaseline(
  db: PrismaClient,
  workspaceId: string,
  raw: unknown,
) {
  const command = baselineCommandSchema.parse(raw);
  if (command.action === "activate")
    return db.$transaction(async (tx) => {
      const row = await tx.integrationResponseBaseline.findFirst({
        where: { workspaceId, id: command.baselineId },
      });
      if (!row) throw new IntegrationScopeError();
      await lockIntegrationKeys(tx, [
        canonical(["baseline", workspaceId, row.scopeKey]),
      ]);
      const current = await tx.integrationResponseBaseline.findFirstOrThrow({
        where: { workspaceId, id: row.id },
      });
      if (current.active) return { id: row.id, created: false, active: true };
      await tx.integrationResponseBaseline.updateMany({
        where: { workspaceId, scopeKey: row.scopeKey, active: true },
        data: { active: false },
      });
      await tx.integrationResponseBaseline.update({
        where: { id: row.id },
        data: { active: true, activatedAt: new Date() },
      });
      await appendAuditLog(tx, {
        workspaceId,
        eventType: "INTEGRATION_BASELINE_ACTIVATED",
        actorType: "HUMAN",
        actorId: "local-pilot",
        metadata: {
          baselineId: row.id,
          version: row.version,
          deploymentVerified: false,
        },
      });
      return { id: row.id, created: false, active: true };
    });
  let integration,
    operation,
    statusCode: number,
    pointers: string[],
    expectedShape: BaselineShape,
    origin: "OBSERVED" | "CONTRACT",
    scopeKey: string;
  let sampleObservationId: string | null = null,
    apiSpecId: string | null = null,
    sourceSha256: string | null = null;
  if (command.action === "observe") {
    const row = await db.integrationObservation.findFirst({
      where: { workspaceId, id: command.observationId },
    });
    if (!row) throw new IntegrationScopeError();
    const event = observationSchema.parse(row.envelope);
    if (
      event.result.kind !== "HTTP" ||
      !event.result.originMatched ||
      event.capture.state !== "CAPTURED" ||
      !event.capture.projection ||
      !event.capture.pointers.length
    )
      throw new IntegrationScopeError();
    integration = event.integration;
    operation = event.operation;
    statusCode = event.result.statusCode;
    pointers = event.capture.pointers;
    expectedShape = baselineShapeSchema.parse({
      version: 1,
      rootType: event.capture.projection.rootType,
      fields: event.capture.projection.fields.map((field) => ({
        ...field,
        required: false,
      })),
    });
    origin = "OBSERVED";
    sampleObservationId = row.id;
    scopeKey = baselineScope(event, statusCode, pointers);
    if (
      scopeKey !== row.scopeKey ||
      row.integrationKey !== integration.key ||
      row.providerKey !== integration.provider ||
      row.environment !== integration.environment
    )
      throw new IntegrationScopeError();
  } else {
    const spec = await db.apiSpec.findFirst({
      where: {
        workspaceId,
        id: command.apiSpecId,
        apiKey: command.integration.key,
        environment: command.integration.environment,
        sourceSha256: command.sourceSha256,
      },
    });
    if (!spec) throw new IntegrationScopeError();
    integration = command.integration;
    operation = command.operation;
    statusCode = command.statusCode;
    pointers = command.pointers;
    expectedShape = contractShape(spec.parsedDocument, command);
    origin = "CONTRACT";
    apiSpecId = spec.id;
    sourceSha256 = spec.sourceSha256;
    scopeKey = baselineScope(command, statusCode, pointers);
  }
  const importDigest = digest({
    origin,
    sampleObservationId,
    apiSpecId,
    sourceSha256,
    expectedShape,
    pointers: pointers.slice().sort(),
  });
  return db.$transaction(async (tx) => {
    await lockIntegrationKeys(tx, [
      canonical(["baseline", workspaceId, scopeKey]),
    ]);
    const existing = await tx.integrationResponseBaseline.findUnique({
      where: {
        workspaceId_scopeKey_importDigest: {
          workspaceId,
          scopeKey,
          importDigest,
        },
      },
    });
    if (existing)
      return { id: existing.id, created: false, active: existing.active };
    const previous = await tx.integrationResponseBaseline.findFirst({
      where: { workspaceId, scopeKey },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    const row = await tx.integrationResponseBaseline.create({
      data: {
        workspaceId,
        scopeKey,
        integrationKey: integration.key,
        providerKey: integration.provider,
        environment: integration.environment,
        httpMethod: operation.method,
        operationPath: operation.path,
        statusCode,
        version: (previous?.version ?? 0) + 1,
        origin,
        sampleObservationId,
        apiSpecId,
        sourceSha256,
        expectedShape,
        pointers: pointers.slice().sort(),
        importDigest,
      },
    });
    await appendAuditLog(tx, {
      workspaceId,
      eventType: "INTEGRATION_BASELINE_CREATED",
      actorType: "HUMAN",
      actorId: "local-pilot",
      metadata: {
        baselineId: row.id,
        origin,
        version: row.version,
        active: false,
        deploymentVerified: false,
      },
    });
    return { id: row.id, created: true, active: false };
  });
}
