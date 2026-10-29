import { createHash } from "node:crypto";
import { z } from "zod";

export const WEBHOOK_GROUPING_VERSION = 1;
export const webhookGroupingReason = z.enum(["GROUPED", "NOT_A_MISMATCH", "SENDER_UNVERIFIED", "SENDER_PROVENANCE_INVALID",
  "REVISION_UNAVAILABLE", "EVIDENCE_UNSUPPORTED", "INELIGIBLE_SCOPE"]);
export type WebhookGroupingReason = z.infer<typeof webhookGroupingReason>;
const finding = z.object({ jsonPointer: z.enum(["/", "/amount"]), keyword: z.enum(["type", "required"]),
  schemaPath: z.enum(["#/required", "#/properties/amount/type"]), message: z.string().max(1024),
  expected: z.enum(["integer", "number", "string", "boolean", "null", "object", "array"]).optional(),
  observedType: z.enum(["number", "string", "boolean", "null", "object", "array"]).optional(),
  missingProperty: z.literal("amount").optional(),
}).strict();

export function webhookDriftFingerprint(rawFindings: unknown): string | null {
  const parsed = z.array(finding).min(1).max(32).safeParse(rawFindings);
  if (!parsed.success) return null;
  const tokens: string[] = [];
  for (const item of parsed.data) {
    if (item.keyword === "type") {
      if (item.jsonPointer !== "/amount" || item.schemaPath !== "#/properties/amount/type" || !item.expected || !item.observedType || item.missingProperty) return null;
      tokens.push(JSON.stringify(["/amount", "type", item.schemaPath, item.expected, item.observedType]));
    } else {
      if (item.jsonPointer !== "/" || item.schemaPath !== "#/required" || item.missingProperty !== "amount" || item.expected || item.observedType !== "object") return null;
      tokens.push(JSON.stringify(["/amount", "required", item.schemaPath, "present", "missing"]));
    }
  }
  return createHash("sha256").update(JSON.stringify(["synthetic-amount-drift@1", [...new Set(tokens)].sort()])).digest("hex");
}

export function webhookGroupingLabel(reason: string | null, validationStatus: string): string {
  if (reason === null) return validationStatus === "NOT_RUN" ? "Not evaluated · validation pending" : "Not evaluated by this grouping version";
  switch (reason) {
    case "GROUPED": return "Grouped by verified sender, drift and revision";
    case "NOT_A_MISMATCH": return "Not grouped · no conclusive mismatch";
    case "SENDER_UNVERIFIED": return "Not grouped · sender unverified";
    case "SENDER_PROVENANCE_INVALID": return "Not grouped · sender provenance unavailable";
    case "REVISION_UNAVAILABLE": return "Not grouped · revision evidence unavailable";
    case "EVIDENCE_UNSUPPORTED": return "Not grouped · unsupported drift evidence";
    case "INELIGIBLE_SCOPE": return "Not grouped · outside the synthetic scope";
    default: return "Grouping decision unavailable";
  }
}
