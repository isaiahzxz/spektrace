import { z } from "zod";
import { proposalPlanSchema, type ProposalInput } from "./contract";

const envelopeSchema = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }), finish_reason: z.unknown().optional() })).min(1) });
type Field = "root" | "choices" | "message" | "content" | "decision" | "operation" | "findingIndex" | "jsonPointer" | "reasonCode" | "extra_fields";
type Rule = "type" | "value" | "format" | "minimum" | "maximum" | "union" | "extra_fields" | "other";
export type ProposalResponseDiagnostic = {
  code: "PROPOSAL_RESPONSE_TOO_LARGE" | "PROPOSAL_ENVELOPE_NOT_JSON" | "PROPOSAL_ENVELOPE_INVALID" | "PROPOSAL_CONTENT_TOO_LARGE" | "PROPOSAL_CONTENT_NOT_JSON" | "PROPOSAL_PLAN_INVALID" | "PROPOSAL_PLAN_NOT_OFFERED" | "PROPOSAL_PLAN_ACCEPTED" | "PROPOSAL_PLAN_ABSTAINED";
  responseBytes: number;
  contentBytes?: number;
  finishReason?: "stop" | "length" | "content_filter" | "tool_calls" | "unknown";
  issues?: { field: Field; rule: Rule }[];
  issueCount?: number;
  issuesTruncated?: boolean;
  httpStatus?: number;
  decisionState?: "missing" | "invalid_type" | "unsupported" | "allowed";
};
const knownFields = new Set<Field>(["choices", "message", "content", "decision", "operation", "findingIndex", "jsonPointer", "reasonCode"]);
function safeIssues(error: z.ZodError): Pick<ProposalResponseDiagnostic, "issues" | "issueCount" | "issuesTruncated"> {
  return {
    issues: error.issues.slice(0, 8).map(issue => {
      const field = issue.code === "unrecognized_keys" ? "extra_fields" : issue.path.findLast(part => typeof part === "string" && knownFields.has(part as Field));
      const rules: Record<string, Rule> = { invalid_type: "type", invalid_value: "value", invalid_format: "format", too_small: "minimum", too_big: "maximum", invalid_union: "union", unrecognized_keys: "extra_fields" };
      return { field: (field ?? "root") as Field, rule: rules[issue.code] ?? "other" };
    }),
    issueCount: Math.min(error.issues.length, 255), issuesTruncated: error.issues.length > 8,
  };
}
export function inspectProposalResponse(text: string, input: ProposalInput, httpStatus?: number):
  | { ok: true; plan: z.infer<typeof proposalPlanSchema>; diagnostic: ProposalResponseDiagnostic }
  | { ok: false; diagnostic: ProposalResponseDiagnostic } {
  const base: Omit<ProposalResponseDiagnostic, "code"> = { responseBytes: Buffer.byteLength(text, "utf8"), ...(Number.isInteger(httpStatus) && httpStatus! >= 100 && httpStatus! <= 599 ? { httpStatus } : {}) };
  const fail = (code: ProposalResponseDiagnostic["code"], extra: Partial<ProposalResponseDiagnostic> = {}) => ({ ok: false as const, diagnostic: { ...base, ...extra, code } });
  if (base.responseBytes > 8_192) return fail("PROPOSAL_RESPONSE_TOO_LARGE");
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return fail("PROPOSAL_ENVELOPE_NOT_JSON"); }
  const envelope = envelopeSchema.safeParse(raw);
  if (!envelope.success) return fail("PROPOSAL_ENVELOPE_INVALID", safeIssues(envelope.error));
  const choice = envelope.data.choices[0]!;
  base.contentBytes = Buffer.byteLength(choice.message.content, "utf8");
  base.finishReason = typeof choice.finish_reason === "string" && ["stop", "length", "content_filter", "tool_calls"].includes(choice.finish_reason) ? choice.finish_reason as "stop" | "length" | "content_filter" | "tool_calls" : "unknown";
  if (choice.message.content.length > 2_048) return fail("PROPOSAL_CONTENT_TOO_LARGE");
  try { raw = JSON.parse(choice.message.content); } catch { return fail("PROPOSAL_CONTENT_NOT_JSON"); }
  const decision = raw && typeof raw === "object" && !Array.isArray(raw) && Object.hasOwn(raw, "decision") ? (raw as Record<string, unknown>).decision : undefined;
  base.decisionState = decision === undefined ? "missing" : typeof decision !== "string" ? "invalid_type" : ["propose", "abstain"].includes(decision) ? "allowed" : "unsupported";
  const plan = proposalPlanSchema.safeParse(raw);
  if (!plan.success) return fail("PROPOSAL_PLAN_INVALID", safeIssues(plan.error));
  if (plan.data.decision === "propose") {
    const selected = plan.data;
    if (!input.findings.some(f => f.findingIndex === selected.findingIndex && f.jsonPointer === selected.jsonPointer)) return fail("PROPOSAL_PLAN_NOT_OFFERED");
  }
  return { ok: true, plan: plan.data, diagnostic: { ...base, code: plan.data.decision === "propose" ? "PROPOSAL_PLAN_ACCEPTED" : "PROPOSAL_PLAN_ABSTAINED" } };
}
