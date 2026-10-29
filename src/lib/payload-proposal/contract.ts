import { z } from "zod";
import { scanSerializedBundleForLeaks } from "@/lib/agent-evidence/outbound-scan";
import { redactSanitizedRequestBody } from "@/lib/redaction/sanitize-body";

const proposalPointer = z.string().min(2).max(256).regex(/^\/(?:[A-Za-z_][A-Za-z0-9_]*)(?:\/[A-Za-z_][A-Za-z0-9_]*)*$/).refine((pointer) => !pointer.slice(1).split("/").some((key) => ["__proto__", "prototype", "constructor"].includes(key)));
export const proposalInputSchema = z.object({
  version: z.literal(1),
  findings: z.array(z.object({ findingIndex: z.number().int().min(0).max(31), jsonPointer: proposalPointer, rule: z.literal("type"), observedType: z.literal("string"), expectedType: z.literal("integer") }).strict()).min(1).max(32),
}).strict();
export type ProposalInput = z.infer<typeof proposalInputSchema>;
export const proposalPlanSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("propose"), operation: z.literal("canonical_integer_string_to_integer"), findingIndex: z.number().int().min(0).max(31), jsonPointer: proposalPointer }).strict(),
  z.object({ decision: z.literal("abstain"), reasonCode: z.enum(["UNSUPPORTED_TRANSFORMATION", "INSUFFICIENT_EVIDENCE"]) }).strict(),
]);
export type ProposalAdapter = { provider: string; model: string; propose(input: ProposalInput): Promise<unknown> };

const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);
export function safeProposalBody(body: unknown): string | null {
  let nodes = 0;
  const seen = new Set<object>();
  function safe(value: unknown, depth: number): boolean {
    if (++nodes > 200 || depth > 8) return false;
    if (typeof value === "string") return !/\[(?:REDACTED|OMITTED[^\]]*)\]/i.test(value);
    if (typeof value === "number") return Number.isFinite(value);
    if (value === null || typeof value === "boolean") return true;
    if (typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    return Object.entries(value).every(([key, child]) => !forbiddenKeys.has(key) && safe(child, depth + 1));
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || !safe(body, 0)) return null;
  const text = JSON.stringify(body);
  if (Buffer.byteLength(text, "utf8") > 16_384 || !scanSerializedBundleForLeaks(text).safe) return null;
  const redacted = redactSanitizedRequestBody(body);
  if (redacted.incomplete || redacted.validationBlocked || redacted.redactedPaths.length || JSON.stringify(redacted.value) !== text) return null;
  return text;
}

export function createIntegerCandidate(body: unknown, pointer: string): { candidateText: string } | null {
  const original = safeProposalBody(body);
  if (!original || !/^\/(?:[A-Za-z_][A-Za-z0-9_]*)(?:\/[A-Za-z_][A-Za-z0-9_]*)*$/.test(pointer)) return null;
  const segments = pointer.slice(1).split("/");
  if (segments.some((segment) => forbiddenKeys.has(segment))) return null;
  const candidate: unknown = JSON.parse(original);
  let parent = candidate;
  for (const segment of segments.slice(0, -1)) {
    if (!parent || typeof parent !== "object" || Array.isArray(parent) || !Object.hasOwn(parent, segment)) return null;
    parent = (parent as Record<string, unknown>)[segment];
  }
  const key = segments.at(-1)!;
  if (!parent || typeof parent !== "object" || Array.isArray(parent) || !Object.hasOwn(parent, key)) return null;
  const value = (parent as Record<string, unknown>)[key];
  if (typeof value !== "string" || !/^(?:0|-?[1-9]\d*)$/.test(value)) return null;
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || String(numeric) !== value) return null;
  (parent as Record<string, unknown>)[key] = numeric;
  if (!safeProposalBody(candidate)) return null;
  return { candidateText: JSON.stringify(candidate, null, 2) };
}
