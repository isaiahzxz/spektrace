import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { protectedWebhookSchema } from "@/lib/ingestion/synthetic-webhook";
import { resolveOpenApiJsonRequestBodySchema } from "@/lib/validation/resolve-openapi-request-schema";
import { validateJsonSchemaPayload } from "@/lib/validation/validate-json-schema";
import { buildUnsupportedEvidenceV1, type ValidationEvidenceV1 } from "@/lib/validation/validation-evidence-v1";
import { recordWebhookGrouping } from "@/server/services/group-webhook-drift";
import { webhookRevisionSelectionSchema } from "@/lib/ingestion/webhook-revision";

export async function processWebhookValidation(db: PrismaClient, workspaceId: string, receiptId: string) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM webhook_receipts WHERE id = ${receiptId}::uuid AND workspace_id = ${workspaceId}::uuid FOR UPDATE`;
    const row = await tx.webhookReceipt.findFirst({ where: { id: receiptId, workspaceId }, include: { apiSpec: true } });
    if (!row) return { status: "skipped", reason: "receipt_not_found" } as const;
    if (row.validationStatus !== "NOT_RUN") return { status: "skipped", reason: "already_completed" } as const;
    const unsupported = (code: string, message: string) => buildUnsupportedEvidenceV1({ reasonCode: code, reasonMessage: message,
      apiSpecId: row.apiSpecId, sourceSha256: row.apiSpec?.sourceSha256 });
    let evidence: ValidationEvidenceV1;
    const body = protectedWebhookSchema.safeParse({ payload: row.sanitizedPayload, protection: row.protection });
    const spec = row.apiSpec;
    const pin = webhookRevisionSelectionSchema.safeParse(row.revisionSelection);
    if (!body.success || body.data.protection.omittedFields.length) {
      evidence = unsupported("WEBHOOK_PAYLOAD_INCOMPLETE", "Fields were omitted by the synthetic protection policy. The original body cannot be conclusively validated.");
    } else if (!spec || spec.workspaceId !== workspaceId || spec.apiKey !== row.apiKey || spec.environment !== row.environment ||
      !pin.success || pin.data.apiSpecId !== spec.id || pin.data.sourceSha256 !== spec.sourceSha256) {
      evidence = unsupported("ACCEPTANCE_SPEC_UNAVAILABLE", "No usable revision was pinned at acceptance. No current-revision fallback was used.");
    } else {
      const resolved = resolveOpenApiJsonRequestBodySchema({ parsedDocument: spec.parsedDocument, openApiVersion: spec.openApiVersion,
        apiSpecId: spec.id, sourceSha256: spec.sourceSha256, httpMethod: "POST", requestPath: row.operationPath });
      if (resolved.status === "unsupported") evidence = unsupported(resolved.reasonCode, "The pinned body schema is outside the supported validation scope.");
      else {
        const result = validateJsonSchemaPayload(resolved.requestBodySchema, body.data.payload);
        if (result.status === "error" || result.status === "unsupported") evidence = unsupported("SCHEMA_UNSUPPORTED", "The pinned body check could not be completed.");
        else evidence = {
          version: 1, checkedAt: new Date().toISOString(), outcome: result.status === "passed" ? "PASSED" : "MISMATCH",
          scope: { label: "openapi_request_body", covers: "json_request_body_only", openApiVersion: resolved.openApiVersion,
            matchedMethod: "POST", matchedPath: resolved.matchedPath },
          specRevision: { apiSpecId: spec.id, sourceSha256: spec.sourceSha256 },
          validator: { engine: "ajv", schemaDialect: "https://json-schema.org/draft/2020-12/schema" },
          findings: result.evidence, reasonCode: result.status === "passed" ? null : "SCHEMA_MISMATCH", redactedPaths: [],
          reasonMessage: "Synthetic request-body check only. Acceptance does not prove business processing or backend correctness.",
          plainEnglishSummary: null,
        };
      }
    }
    const validated = await tx.webhookReceipt.update({ where: { id: row.id }, data: { validationStatus: evidence.outcome,
      validationEvidence: evidence as Prisma.InputJsonValue, validatedAt: new Date() } });
    await recordWebhookGrouping(tx, validated);
    return { status: "processed", validationStatus: evidence.outcome } as const;
  });
}
