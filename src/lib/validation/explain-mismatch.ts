import type { ValidationEvidenceItem } from "@/lib/validation/validate-json-schema";

const OBSERVED_TYPE_PHRASE: Record<string, string> = {
  string: "text (a string)",
  boolean: "a true/false value",
  array: "a list",
  object: "an object",
  null: "null",
};

export function plainEnglishFromFindings(
  findings: ValidationEvidenceItem[],
): string | null {
  const typeMismatch = findings.find((f) => f.keyword === "type");
  if (!typeMismatch) {
    return null;
  }

  const pointer = typeMismatch.jsonPointer;
  const field = pointer.split("/").filter(Boolean).pop() ?? "value";

  if (typeMismatch.expected?.includes("integer")) {
    if (typeMismatch.observedType === "number") {
      return `The ${field} must be a whole number. The request supplied a decimal.`;
    }
    const observed =
      (typeMismatch.observedType && OBSERVED_TYPE_PHRASE[typeMismatch.observedType]) ??
      "an incompatible value";
    return `The ${field} must be a whole number. The request supplied ${observed}.`;
  }

  return typeMismatch.message;
}
