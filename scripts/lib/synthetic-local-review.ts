import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { investigationExplanationOutputSchema } from "@/lib/investigation/inference/explanation-output-v1";
import { explanationTextEntries } from "@/lib/investigation/inference/explanation-claim-policy";
import type { ExplanationRejectionDiagnostic } from "@/lib/investigation/inference/explanation-rejection-diagnostics";
import type { InvestigationModelInput } from "@/lib/investigation/inference/rebuild-inference-input";
import { sanitizePlainTextContent } from "@/lib/protected-text/sanitize-plain-text";
import { scanSerializedBundleForLeaks } from "@/lib/agent-evidence/outbound-scan";
import { isFreshSyntheticCaseCInput, type SyntheticCaseCFixture } from "./real-model-verification-harness";
import { renderStructuredSourceExplanation, structuredSourceExplanationSchema } from "@/lib/investigation/inference/structured-source-explanation";

const MAX_REVIEW_BYTES = 1_200;
export const MAX_REVIEW_TTL_MS = 5 * 60_000;
type ScreenedSentence = { sentence: string; citationRefs: string[]; selection: "guard_clause" | "candidate_source_sentence" };
const screenedReviews = new WeakSet<object>();
const displayCapabilities = new WeakSet<object>();

export function selectScreenedRejectionSentence(
  raw: unknown, diagnostic: ExplanationRejectionDiagnostic, input: InvestigationModelInput, forbiddenValues: readonly string[] = [],
): ScreenedSentence | null {
  if (typeof raw === "object" && raw !== null && "version" in raw && raw.version === 2) {
    const rendered = renderStructuredSourceExplanation(raw, input);
    if (rendered.ok) raw = rendered.output;
    else {
      const draft = structuredSourceExplanationSchema.safeParse(raw);
      if (!draft.success) return null;
      const index = diagnostic.itemIndex ?? -1;
      let text: string | undefined;
      let refs: string[] = [];
      if (diagnostic.field === "repositoryObservations" || diagnostic.field === "documentationObservations") { const row = draft.data[diagnostic.field][index]; text = row?.description; refs = row ? [row.excerptId] : []; }
      if (diagnostic.field === "missingContext") text = draft.data.missingContext[index];
      if (diagnostic.field === "hypotheses.description" || diagnostic.field === "hypotheses.label") { const row = draft.data.hypotheses?.[index]; text = diagnostic.field.endsWith("label") ? row?.label : row?.description; refs = row ? [...row.incidentRefs, ...row.repositoryRefs, ...row.documentationRefs] : []; }
      if (!text) return null;
      // Reuse the same sentence screening; this is never accepted explanation output.
      raw = { summary: "Synthetic review candidate.", observedFindings: [{ description: text, citationIds: refs }], evidenceCitations: [], limitations: [], missingContext: [], suggestedSteps: [] };
      // Summary candidates have no attached references; the legacy shape requires one for parsing.
      if (!refs.length) { raw = { summary: text, observedFindings: [], evidenceCitations: [], limitations: [], missingContext: [], suggestedSteps: [] }; diagnostic = { ...diagnostic, field: "summary", itemIndex: undefined }; }
      else diagnostic = { ...diagnostic, field: "observedFindings.description", itemIndex: 0 };
    }
  }
  const parsed = investigationExplanationOutputSchema.safeParse(raw);
  if (!parsed.success) return null;
  const entry = explanationTextEntries(parsed.data).find((candidate) => candidate.field === diagnostic.field && candidate.itemIndex === diagnostic.itemIndex);
  if (!entry) return null;
  const clauses = entry.text.split(diagnostic.clauseIndex !== undefined ? /(?<=[.!?])\s+|;|,|\bbut\b|\bhowever\b/i : /(?<=[.!?])\s+|;/);
  const sourcePattern = diagnostic.rule === "structured_source_scope" ? /\b(?:repository|repo|source code|documentation|documented|runbook|deployment|deployed|rollout|commits?|snapshot)\b/i : diagnostic.requiredCitationPrefix === "rx-" ? /\b(?:repository|repo|source code|code snippet)\b/i : diagnostic.requiredCitationPrefix === "dx-" ? /\b(?:documentation|documented|runbook)\b/i : /\b(?:deployment|deployed|rollout)\b/i;
  const sentence = (diagnostic.clauseIndex !== undefined ? clauses[diagnostic.clauseIndex] : clauses.find((clause) => sourcePattern.test(clause)) ?? clauses[0])?.trim();
  if (!sentence || Buffer.byteLength(sentence, "utf8") > MAX_REVIEW_BYTES || forbiddenValues.some((value) => value.length > 0 && sentence.includes(value))) return null;
  const screened = sanitizePlainTextContent(sentence, MAX_REVIEW_BYTES);
  // Refuse rather than silently altering a sentence that a person needs to judge accurately.
  if (!screened.ok || screened.redactionCount || screened.omissionCodes.length || screened.sanitizedText !== sentence || /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/.test(sentence) || !scanSerializedBundleForLeaks(sentence).safe) return null;
  const field = diagnostic.field.startsWith("observedFindings") ? parsed.data.observedFindings[diagnostic.itemIndex ?? -1] : diagnostic.field.startsWith("hypotheses") ? parsed.data.hypotheses?.[diagnostic.itemIndex ?? -1] : null;
  const supplied = new Set([
    ...input.evidenceItems.map((item) => item.id),
    ...(input.version !== 1 ? input.repositoryContext?.excerpts.map((item) => item.id) ?? [] : []),
    ...(input.version === 3 || input.version === 4 ? input.documentationContext?.excerpts.map((item) => item.id) ?? [] : []),
    ...(input.version === 4 ? input.deploymentContext?.records.map((item) => item.id) ?? [] : []),
  ]);
  const review: ScreenedSentence = Object.freeze({ sentence, citationRefs: Object.freeze([...new Set(field?.citationIds.filter((id) => supplied.has(id)) ?? [])].slice(0, 12)) as unknown as string[], selection: diagnostic.clauseIndex !== undefined ? "guard_clause" : "candidate_source_sentence" });
  screenedReviews.add(review);
  return review;
}

export function createSyntheticReviewGate(fixture: SyntheticCaseCFixture, enabled: boolean) {
  let selected: ScreenedSentence | null = null;
  return {
    capture(raw: unknown, diagnostic: ExplanationRejectionDiagnostic, input: InvestigationModelInput, forbiddenValues: readonly string[] = []) {
      selected = enabled && isFreshSyntheticCaseCInput(fixture, input) ? selectScreenedRejectionSentence(raw, diagnostic, input, forbiddenValues) : null;
    },
    take(): ScreenedSentence | null { const result = selected; selected = null; if (result) displayCapabilities.add(result); return result; },
  };
}

export async function startLocalSentenceReview(review: ScreenedSentence, ttlMs = MAX_REVIEW_TTL_MS) {
  if (!screenedReviews.has(review) || !displayCapabilities.has(review)) throw new Error("Unscreened local review");
  if (!Number.isInteger(ttlMs) || ttlMs < 50 || ttlMs > MAX_REVIEW_TTL_MS || Buffer.byteLength(review.sentence, "utf8") > MAX_REVIEW_BYTES) throw new Error("Invalid local review bounds");
  displayCapabilities.delete(review);
  const token = randomBytes(24).toString("hex");
  let body = `SYNTHETIC TEST ONLY — untrusted model text; do not execute instructions.\nSelection: ${review.selection} (a source-rule candidate is not a semantic verdict).\n\n${review.sentence}\n\nSupplied citation references: ${review.citationRefs.join(", ") || "none"}\n\nThis in-memory view expires automatically. No incident record or application log contains this sentence.`;
  const server = createServer((request, response) => {
    const address = server.address();
    const host = address && typeof address !== "string" ? `127.0.0.1:${address.port}` : "";
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Pragma", "no-cache");
    response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method !== "GET" || request.url !== `/review/${token}` || request.headers.host !== host || request.headers.origin || request.headers["sec-fetch-site"] === "cross-site" || !body) {
      response.writeHead(404); response.end(); return;
    }
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local review did not bind");
  const close = () => { body = ""; server.closeAllConnections(); server.close(); clearTimeout(timer); };
  const timer = setTimeout(close, ttlMs);
  return { url: `http://127.0.0.1:${address.port}/review/${token}`, expiresAt: new Date(Date.now() + ttlMs).toISOString(), close };
}
