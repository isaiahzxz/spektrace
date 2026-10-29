import { z } from "zod";
import { createHash } from "node:crypto";

export const labelSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
export const operationSchema = z
  .object({
    method: z.enum([
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "HEAD",
      "OPTIONS",
    ]),
    path: z
      .string()
      .max(256)
      .regex(
        /^\/(?:[A-Za-z][A-Za-z0-9_.-]*|\{[A-Za-z][A-Za-z0-9_]*\})(?:\/(?:[A-Za-z][A-Za-z0-9_.-]*|\{[A-Za-z][A-Za-z0-9_]*\}))*\/?$/,
      ),
  })
  .strict();
export const identitySchema = z
  .object({ key: labelSchema, provider: labelSchema, environment: labelSchema })
  .strict();
export const correlationSchema = z
  .object({
    kind: z.enum(["workflow", "job", "trace"]),
    id: z.string().uuid(),
    attempt: z.number().int().min(1).max(1000),
  })
  .strict();
export const pointerSchema = z
  .string()
  .max(192)
  .refine(
    (value) =>
      value.startsWith("/") &&
      value.split("/").length <= 7 &&
      value
        .split("/")
        .slice(1)
        .every(
          (part) =>
            /^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(part) &&
            !["__proto__", "constructor", "prototype"].includes(part),
        ),
    "Unsupported selected field pointer",
  );
export const jsonTypeSchema = z.enum([
  "object",
  "array",
  "string",
  "integer",
  "number",
  "boolean",
  "null",
]);
export const fieldShapeSchema = z
  .object({
    pointer: pointerSchema,
    presence: z.enum(["present", "missing"]),
    type: jsonTypeSchema.nullable(),
    elementTypes: z.array(jsonTypeSchema).max(7).optional(),
  })
  .strict()
  .refine(
    (field) =>
      (field.presence === "missing"
        ? field.type === null && !field.elementTypes
        : field.type !== null) &&
      (field.elementTypes === undefined ||
        (field.type === "array" &&
          new Set(field.elementTypes).size === field.elementTypes.length)),
  );
export const projectionSchema = z
  .object({
    policy: z.literal("selected-fields@1"),
    rootType: jsonTypeSchema,
    fields: z.array(fieldShapeSchema).max(16),
  })
  .strict()
  .refine(
    (shape) =>
      new Set(shape.fields.map((field) => field.pointer)).size ===
      shape.fields.length,
  );
export type Projection = z.infer<typeof projectionSchema>;
export const captureSchema = z
  .object({
    state: z.enum(["OFF", "CAPTURED", "OMITTED", "NO_RESPONSE"]),
    pointers: z.array(pointerSchema).max(16),
    projection: projectionSchema.nullable(),
    omission: z
      .enum([
        "BODY_LIMIT",
        "BODY_TIMEOUT",
        "NOT_JSON",
        "INVALID_JSON",
        "UNSUPPORTED_VALUE",
        "CLOSED",
      ])
      .nullable(),
  })
  .strict()
  .refine(
    (capture) =>
      new Set(capture.pointers).size === capture.pointers.length &&
      (capture.state === "CAPTURED"
        ? capture.projection !== null &&
          capture.omission === null &&
          JSON.stringify([...capture.pointers].sort()) ===
            JSON.stringify(
              capture.projection.fields.map((field) => field.pointer).sort(),
            )
        : capture.projection === null) &&
      (capture.state !== "OFF" || capture.pointers.length === 0) &&
      (capture.state === "OMITTED"
        ? capture.omission !== null
        : capture.omission === null),
  );
const resultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("HTTP"),
      originMatched: z.boolean(),
      statusCode: z.number().int().min(200).max(599),
      providerVersion: z
        .string()
        .regex(/^[0-9][A-Za-z0-9._-]{0,31}$/)
        .nullable(),
    })
    .strict(),
  z.object({ kind: z.enum(["TIMEOUT", "TRANSPORT", "ABORTED"]) }).strict(),
]);
export const observationSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("observation"),
    sourceEventId: z.string().uuid(),
    callId: z.string().uuid(),
    attempt: z.number().int().min(1).max(1000),
    integration: identitySchema,
    operation: operationSchema,
    occurredAt: z.string().datetime(),
    durationMs: z.number().finite().min(0).max(86_400_000),
    result: resultSchema,
    capture: captureSchema,
    correlation: correlationSchema.nullable(),
    sampleRate: z.number().finite().min(0).max(1),
    requestIncidentId: z.string().uuid().optional(),
  })
  .strict()
  .refine((event) =>
    event.result.kind === "HTTP"
      ? event.capture.state !== "NO_RESPONSE"
      : event.capture.state === "NO_RESPONSE",
  );
export type ObservationInput = z.infer<typeof observationSchema>;
const count = z.number().int().min(0).max(1_000_000_000);
export const coverageSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("coverage"),
    sourceEventId: z.string().uuid(),
    instanceId: z.string().uuid(),
    sequence: z.number().int().min(1).max(1_000_000_000),
    integration: identitySchema,
    startedAt: z.string().datetime(),
    reportedAt: z.string().datetime(),
    sampleRate: z.number().finite().min(0).max(1),
    counters: z
      .object({
        seen: count,
        sampled: count,
        unsampled: count,
        dropped: count,
        delivered: count,
        deliveryUnconfirmed: count,
        pending: count,
        bodyOmitted: count,
      })
      .strict(),
  })
  .strict()
  .refine(
    (event) =>
      event.counters.seen ===
        event.counters.sampled + event.counters.unsampled &&
      event.counters.sampled ===
        event.counters.dropped +
          event.counters.delivered +
          event.counters.deliveryUnconfirmed +
          event.counters.pending &&
      event.counters.bodyOmitted <= event.counters.sampled,
  );
export type CoverageInput = z.infer<typeof coverageSchema>;
export const outcomeSchema = z
  .object({
    version: z.literal(1),
    sourceEventId: z.string().uuid(),
    integration: identitySchema,
    correlation: correlationSchema,
    outcome: z.enum(["SUCCEEDED", "FAILED", "CANCELLED"]),
    occurredAt: z.string().datetime(),
  })
  .strict();
export type OutcomeInput = z.infer<typeof outcomeSchema>;
export const baselineCommandSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("observe"), observationId: z.string().uuid() })
    .strict(),
  z
    .object({
      action: z.literal("contract"),
      integration: identitySchema,
      operation: operationSchema,
      apiSpecId: z.string().uuid(),
      sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
      statusCode: z.number().int().min(200).max(599),
      pointers: z.array(pointerSchema).min(1).max(16),
    })
    .strict(),
  z
    .object({ action: z.literal("activate"), baselineId: z.string().uuid() })
    .strict(),
]);
export type BaselineCommand = z.infer<typeof baselineCommandSchema>;
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function digest(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function policyHash(pointers: readonly string[]) {
  return digest({
    policy: "selected-fields@1",
    pointers: [...pointers].sort(),
  });
}
export function baselineScope(
  event: Pick<ObservationInput, "integration" | "operation">,
  statusCode: number,
  pointers: readonly string[],
) {
  return digest({
    integration: event.integration,
    operation: event.operation,
    statusCode,
    policy: policyHash(pointers),
  });
}
export const baselineShapeSchema = z
  .object({
    version: z.literal(1),
    rootType: jsonTypeSchema,
    fields: z
      .array(
        z
          .object({
            pointer: pointerSchema,
            presence: z.enum(["present", "missing"]),
            type: jsonTypeSchema.nullable(),
            required: z.boolean(),
            elementTypes: z.array(jsonTypeSchema).max(7).optional(),
          })
          .strict(),
      )
      .max(16),
  })
  .strict()
  .refine(
    (shape) =>
      new Set(shape.fields.map((field) => field.pointer)).size ===
      shape.fields.length,
  );
export type BaselineShape = z.infer<typeof baselineShapeSchema>;
