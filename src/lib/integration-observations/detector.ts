import { z } from "zod";
import {
  baselineShapeSchema,
  digest,
  observationSchema,
  type BaselineShape,
  type ObservationInput,
  type Projection,
} from "./contract";
const changeSchema = z
  .object({
    pointer: z.string().max(192),
    rule: z.enum([
      "ROOT_TYPE_CHANGED",
      "TYPE_CHANGED",
      "FIELD_MISSING",
      "FIELD_ADDED",
      "ARRAY_TYPES_CHANGED",
    ]),
    expectedType: z.string().max(16).nullable(),
    receivedType: z.string().max(16).nullable(),
  })
  .strict();
export const detectorEvidenceSchema = z
  .object({
    version: z.literal(1),
    code: z.enum([
      "NO_RESPONSE",
      "CAPTURE_OFF",
      "INCOMPLETE",
      "NO_BASELINE",
      "UNSUPPORTED",
      "MATCH",
      "ADDITION_ONLY",
      "DRIFT",
      "CONTRACT_MISMATCH",
    ]),
    baseline: z
      .object({
        id: z.string().uuid(),
        version: z.number().int().positive(),
        origin: z.enum(["OBSERVED", "CONTRACT"]),
      })
      .strict()
      .nullable(),
    changes: z.array(changeSchema).max(33),
    scope: z.literal("selected_fields_only"),
    causationEstablished: z.literal(false),
  })
  .strict();
export type DetectorEvidence = z.infer<typeof detectorEvidenceSchema>;
function accepts(
  expected: string | null,
  actual: string | null,
  contract: boolean,
) {
  return (
    expected === actual ||
    (contract && expected === "number" && actual === "integer")
  );
}
export function detectIntegrationChange(
  raw: unknown,
  baseline: {
    id: string;
    version: number;
    origin: string;
    expectedShape: unknown;
  } | null,
): DetectorEvidence {
  const parsed = observationSchema.safeParse(raw);
  const initial = {
    version: 1 as const,
    baseline: null,
    changes: [],
    scope: "selected_fields_only" as const,
    causationEstablished: false as const,
  };
  if (!parsed.success) return { ...initial, code: "UNSUPPORTED" };
  const event = parsed.data;
  if (event.result.kind !== "HTTP") return { ...initial, code: "NO_RESPONSE" };
  if (!event.result.originMatched) return { ...initial, code: "UNSUPPORTED" };
  if (event.capture.state === "OFF") return { ...initial, code: "CAPTURE_OFF" };
  if (event.capture.state !== "CAPTURED" || !event.capture.projection)
    return { ...initial, code: "INCOMPLETE" };
  if (!baseline) return { ...initial, code: "NO_BASELINE" };
  const expected = baselineShapeSchema.safeParse(baseline.expectedShape);
  if (!expected.success || !["OBSERVED", "CONTRACT"].includes(baseline.origin))
    return { ...initial, code: "UNSUPPORTED" };
  const actual = event.capture.projection,
    contract = baseline.origin === "CONTRACT";
  if (
    JSON.stringify(actual.fields.map((f) => f.pointer).sort()) !==
    JSON.stringify(expected.data.fields.map((f) => f.pointer).sort())
  )
    return { ...initial, code: "UNSUPPORTED" };
  const changes: DetectorEvidence["changes"] = [];
  if (!accepts(expected.data.rootType, actual.rootType, contract))
    changes.push({
      pointer: "/",
      rule: "ROOT_TYPE_CHANGED",
      expectedType: expected.data.rootType,
      receivedType: actual.rootType,
    });
  for (const field of expected.data.fields) {
    const observed = actual.fields.find((f) => f.pointer === field.pointer)!;
    if (observed.presence === "missing") {
      if (field.presence === "present" && (!contract || field.required))
        changes.push({
          pointer: field.pointer,
          rule: "FIELD_MISSING",
          expectedType: field.type,
          receivedType: null,
        });
      continue;
    }
    if (field.presence === "missing") {
      if (!contract)
        changes.push({
          pointer: field.pointer,
          rule: "FIELD_ADDED",
          expectedType: null,
          receivedType: observed.type,
        });
      continue;
    }
    if (!accepts(field.type, observed.type, contract))
      changes.push({
        pointer: field.pointer,
        rule: "TYPE_CHANGED",
        expectedType: field.type,
        receivedType: observed.type,
      });
    else if (observed.type === "array" && field.elementTypes) {
      const actualTypes = observed.elementTypes ?? [];
      if (
        contract
          ? actualTypes.some(
              (t) =>
                !field.elementTypes!.some((expected) =>
                  accepts(expected, t, true),
                ),
            )
          : JSON.stringify(field.elementTypes.slice().sort()) !==
            JSON.stringify(actualTypes.slice().sort())
      )
        changes.push({
          pointer: field.pointer,
          rule: "ARRAY_TYPES_CHANGED",
          expectedType: "array",
          receivedType: "array",
        });
    }
  }
  const code = changes.length
    ? changes.every((c) => c.rule === "FIELD_ADDED")
      ? "ADDITION_ONLY"
      : contract
        ? "CONTRACT_MISMATCH"
        : "DRIFT"
    : "MATCH";
  return detectorEvidenceSchema.parse({
    ...initial,
    code,
    changes,
    baseline: {
      id: baseline.id,
      version: baseline.version,
      origin: baseline.origin,
    },
  });
}
export function changeSignature(evidence: DetectorEvidence) {
  return ["DRIFT", "CONTRACT_MISMATCH"].includes(evidence.code)
    ? digest({ baseline: evidence.baseline, changes: evidence.changes })
    : null;
}
export function observedBaselineShape(shape: Projection): BaselineShape {
  return baselineShapeSchema.parse({
    version: 1,
    rootType: shape.rootType,
    fields: shape.fields.map((f) => ({ ...f, required: false })),
  });
}
export function supportedObservation(raw: unknown): ObservationInput | null {
  const parsed = observationSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
