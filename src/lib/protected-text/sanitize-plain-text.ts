const INLINE_SECRET_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /AKIA[0-9A-Z]{16}/g, label: "AWS_ACCESS_KEY" },
  {
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    label: "PRIVATE_KEY_BLOCK",
  },
  { pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, label: "BEARER_TOKEN" },
  { pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{8,}\b/g, label: "STRIPE_KEY" },
  { pattern: /\bghp_[A-Za-z0-9]{20,}\b/g, label: "GITHUB_TOKEN" },
  {
    pattern: /(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*['"][^'"\n]{4,}['"]/gi,
    label: "ASSIGNMENT_LITERAL",
  },
];

export type SanitizePlainTextResult =
  | {
      ok: true;
      sanitizedText: string;
      lineCount: number;
      redactionCount: number;
      omissionCodes: string[];
    }
  | { ok: false; code: string };

function isMostlyText(content: string): boolean {
  if (content.includes("\0")) {
    return false;
  }
  for (let i = 0; i < content.length; i += 1) {
    const code = content.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13) {
      continue;
    }
    if (code < 32) {
      return false;
    }
  }
  return true;
}

/** Heuristic secret redaction for plain text / Markdown. Does not guarantee safety. */
export function sanitizePlainTextContent(
  content: string,
  maxUtf8Bytes: number,
): SanitizePlainTextResult {
  const byteLength = Buffer.byteLength(content, "utf8");
  if (byteLength > maxUtf8Bytes) {
    return { ok: false, code: "CONTENT_TOO_LARGE" };
  }
  if (!isMostlyText(content)) {
    return { ok: false, code: "CONTENT_NOT_TEXT" };
  }

  let sanitizedText = content.replace(/<script[\s\S]*?<\/script>/gi, "[OMITTED:SCRIPT]");
  sanitizedText = sanitizedText.replace(/<[^>]+>/g, "");
  let redactionCount = 0;
  const omissionCodes: string[] = [];
  if (sanitizedText.includes("[OMITTED:SCRIPT]")) {
    omissionCodes.push("OMITTED_SCRIPT");
  }

  for (const { pattern, label } of INLINE_SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (!pattern.test(sanitizedText)) {
      continue;
    }
    pattern.lastIndex = 0;
    sanitizedText = sanitizedText.replace(pattern, () => {
      redactionCount += 1;
      return `[REDACTED:${label}]`;
    });
    omissionCodes.push(`REDACTED_${label}`);
  }

  const lineCount = sanitizedText.length === 0 ? 0 : sanitizedText.split(/\r?\n/).length;
  return {
    ok: true,
    sanitizedText,
    lineCount,
    redactionCount,
    omissionCodes,
  };
}

export function recheckPlainTextExcerpt(
  excerpt: string,
  maxUtf8Bytes: number,
): { ok: true; text: string } | { ok: false; code: string } {
  if (Buffer.byteLength(excerpt, "utf8") > maxUtf8Bytes) {
    return { ok: false, code: "EXCERPT_TOO_LARGE" };
  }
  const res = sanitizePlainTextContent(excerpt, maxUtf8Bytes);
  if (!res.ok) {
    return { ok: false, code: res.code };
  }
  return { ok: true, text: res.sanitizedText };
}
