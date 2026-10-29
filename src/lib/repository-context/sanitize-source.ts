import { REPOSITORY_CONTEXT_LIMITS } from "@/lib/repository-context/config";
import {
  recheckPlainTextExcerpt,
  sanitizePlainTextContent,
  type SanitizePlainTextResult,
} from "@/lib/protected-text/sanitize-plain-text";

export type SanitizeSourceResult = SanitizePlainTextResult;

export function sanitizeRepositorySourceText(content: string): SanitizeSourceResult {
  const res = sanitizePlainTextContent(content, REPOSITORY_CONTEXT_LIMITS.maxFileBytes);
  if (!res.ok && res.code === "CONTENT_TOO_LARGE") {
    return { ok: false, code: "FILE_TOO_LARGE" };
  }
  if (!res.ok && res.code === "CONTENT_NOT_TEXT") {
    return { ok: false, code: "FILE_NOT_TEXT" };
  }
  return res;
}

export function recheckExcerptForExport(excerpt: string): { ok: true; text: string } | { ok: false; code: string } {
  return recheckPlainTextExcerpt(excerpt, REPOSITORY_CONTEXT_LIMITS.maxExcerptUtf8Bytes);
}
