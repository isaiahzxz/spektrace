import { z } from "zod";
import { IncidentSource } from "@/generated/prisma/client";
import { clientAttributionSchema } from "@/lib/ingestion/client-attribution";
import { senderReferenceSchema, senderUuid } from "@/lib/ingestion/sender-identity";

const MAX_STRING = 512;
const MAX_PATH = 2048;
const MAX_BODY_BYTES = 32_768;

const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string().max(MAX_STRING),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValue).max(200),
    z.record(z.string().max(128), jsonValue),
  ]),
);

export const incidentSubmissionSchema = z
  .object({
    source: z.nativeEnum(IncidentSource),
    sourceEventId: z.string().min(1).max(MAX_STRING),
    apiKey: z.string().min(1).max(128),
    environment: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(),
    client: clientAttributionSchema.optional(),
    senderReference: senderReferenceSchema.optional(),
    reportedClientRef: senderUuid.optional(),
    revisionSelectionMode: z.enum(["active_at_ingestion", "historical"]).optional(),
    httpMethod: z.string().min(1).max(16),
    requestPath: z
      .string()
      .min(1)
      .max(MAX_PATH)
      .refine((p) => !p.includes("?") && !p.includes("#"), {
        message: "requestPath must not include query string or fragment",
      })
      .refine((p) => p.startsWith("/"), {
        message: "requestPath must start with /",
      }),
    statusCode: z.number().int().min(400).max(499),
    occurredAt: z.string().datetime(),
    clientReference: z.string().min(1).max(MAX_STRING).optional(),
    sanitizedRequestBody: z.union([jsonValue, z.null()]).optional(),
  })
  .strict();

export type IncidentSubmissionInput = z.infer<typeof incidentSubmissionSchema>;

export function normalizeHttpMethod(method: string): string {
  return method.trim().toUpperCase();
}

export function assertBodySizeLimit(body: unknown): void {
  const serialized = JSON.stringify(body ?? null);
  if (serialized.length > MAX_BODY_BYTES) {
    throw new Error("sanitizedRequestBody exceeds size limit");
  }
}
