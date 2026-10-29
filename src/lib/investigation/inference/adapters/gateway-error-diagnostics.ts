import { utf8ByteLength } from "@/lib/investigation/inference/utf8-byte-length";

const MAX_SUMMARY_CHARS = 240;
const MAX_FIELD_CHARS = 128;
const MAX_BODY_READ_BYTES = 8_192;

export type GatewayThrottleClassification =
  | "temporary_throttling"
  | "quota_or_account_restriction"
  | "model_or_access_restriction"
  | "unknown";

export type GatewayErrorDiagnosticsV1 = {
  httpStatus: number;
  providerErrorType: string | null;
  providerErrorCode: string | null;
  retryAfterSeconds: number | null;
  requestId: string | null;
  classification: GatewayThrottleClassification;
  summary: string;
};

export type ParsedGatewayHttpFailure = {
  failureCode: string;
  retryable: boolean;
  diagnostics: GatewayErrorDiagnosticsV1;
};

function sanitizeOpaqueToken(value: string, maxLen: number): string {
  const trimmed = value.trim().slice(0, maxLen);
  return trimmed.replace(/[^\w.\-:@+/=]/g, "_");
}

function sanitizeSummaryText(value: string): string {
  let text = value.replace(/\s+/g, " ").trim();
  text = text.replace(/sk-[a-z0-9_-]{8,}/gi, "[REDACTED_TOKEN]");
  text = text.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
  if (text.length > MAX_SUMMARY_CHARS) {
    text = `${text.slice(0, MAX_SUMMARY_CHARS - 1)}…`;
  }
  return text;
}

function readRetryAfterSeconds(response: Response): number | null {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) {
    return null;
  }
  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 86_400) {
    return seconds;
  }
  return null;
}

function readRequestId(response: Response): string | null {
  const candidates = [
    response.headers.get("x-request-id"),
    response.headers.get("x-correlation-id"),
    response.headers.get("cf-ray"),
  ];
  for (const value of candidates) {
    if (value?.trim()) {
      return sanitizeOpaqueToken(value, 80);
    }
  }
  return null;
}

function extractProviderErrorFields(body: unknown): {
  type: string | null;
  code: string | null;
  message: string | null;
} {
  if (!body || typeof body !== "object") {
    return { type: null, code: null, message: null };
  }
  const root = body as Record<string, unknown>;
  const error =
    root.error && typeof root.error === "object" ? (root.error as Record<string, unknown>) : root;
  const type = typeof error.type === "string" ? sanitizeOpaqueToken(error.type, MAX_FIELD_CHARS) : null;
  const code = typeof error.code === "string" ? sanitizeOpaqueToken(error.code, MAX_FIELD_CHARS) : null;
  const message = typeof error.message === "string" ? sanitizeSummaryText(error.message) : null;
  return { type, code, message };
}

export function classifyHttp429(input: {
  providerErrorType: string | null;
  providerErrorCode: string | null;
  message: string | null;
  retryAfterSeconds: number | null;
}): GatewayThrottleClassification {
  const blob = `${input.providerErrorType ?? ""} ${input.providerErrorCode ?? ""} ${input.message ?? ""}`.toLowerCase();

  if (
    /quota|billing|credit|insufficient|payment|balance|spend|budget|exceeded.*limit|out of credits/.test(blob)
  ) {
    return "quota_or_account_restriction";
  }
  if (
    /model.*(not found|unavailable|access|permission)|access denied|permission|not authorized|forbidden model/.test(
      blob,
    )
  ) {
    return "model_or_access_restriction";
  }
  if (
    input.retryAfterSeconds !== null ||
    /rate.?limit|too many requests|throttl|retry later|temporarily unavailable/.test(blob)
  ) {
    return "temporary_throttling";
  }
  return "unknown";
}

function failureCodeFor429(classification: GatewayThrottleClassification): string {
  switch (classification) {
    case "temporary_throttling":
      return "GATEWAY_HTTP_429_TEMPORARY";
    case "quota_or_account_restriction":
      return "GATEWAY_HTTP_429_QUOTA";
    case "model_or_access_restriction":
      return "GATEWAY_HTTP_429_ACCESS";
    default:
      return "GATEWAY_HTTP_429_UNKNOWN";
  }
}

function summaryFor429(
  classification: GatewayThrottleClassification,
  message: string | null,
  retryAfterSeconds: number | null,
): string {
  const retry =
    retryAfterSeconds !== null ? ` Retry-After: ${retryAfterSeconds}s (header).` : "";
  switch (classification) {
    case "temporary_throttling":
      return `Gateway returned HTTP 429 with signals consistent with temporary throttling.${retry} Provider message (sanitized): ${message ?? "none supplied."}`;
    case "quota_or_account_restriction":
      return `Gateway returned HTTP 429 with signals consistent with quota, billing, or account limits. Provider message (sanitized): ${message ?? "none supplied."}`;
    case "model_or_access_restriction":
      return `Gateway returned HTTP 429 with signals consistent with model or access restrictions. Provider message (sanitized): ${message ?? "none supplied."}`;
    default:
      return `Gateway returned HTTP 429; cause not established from response metadata.${retry} Provider message (sanitized): ${message ?? "none supplied."}`;
  }
}

function retryableFor429(classification: GatewayThrottleClassification): boolean {
  return classification === "temporary_throttling";
}

export async function readBoundedResponseBody(response: Response): Promise<unknown | null> {
  try {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_BODY_READ_BYTES) {
      return null;
    }
    const text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
    if (utf8ByteLength(text) > MAX_BODY_READ_BYTES) {
      return null;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { _unparsed: sanitizeSummaryText(text) };
    }
  } catch {
    return null;
  }
}

export async function parseGatewayHttpFailure(response: Response): Promise<ParsedGatewayHttpFailure> {
  const httpStatus = response.status;
  const retryAfterSeconds = readRetryAfterSeconds(response);
  const requestId = readRequestId(response);
  const body = await readBoundedResponseBody(response);
  const { type, code, message } = extractProviderErrorFields(body);

  if (httpStatus === 429) {
    const classification = classifyHttp429({
      providerErrorType: type,
      providerErrorCode: code,
      message,
      retryAfterSeconds,
    });
    return {
      failureCode: failureCodeFor429(classification),
      retryable: retryableFor429(classification),
      diagnostics: {
        httpStatus,
        providerErrorType: type,
        providerErrorCode: code,
        retryAfterSeconds,
        requestId,
        classification,
        summary: summaryFor429(classification, message, retryAfterSeconds),
      },
    };
  }

  const classification: GatewayThrottleClassification = "unknown";
  const summary = sanitizeSummaryText(
    message ??
      `Gateway returned HTTP ${httpStatus} without a parseable provider error message.`,
  );
  return {
    failureCode: `GATEWAY_HTTP_${httpStatus}`,
    retryable: httpStatus >= 500,
    diagnostics: {
      httpStatus,
      providerErrorType: type,
      providerErrorCode: code,
      retryAfterSeconds,
      requestId,
      classification,
      summary,
    },
  };
}

export function isRetryableGatewayFailureCode(code: string): boolean {
  return code === "GATEWAY_HTTP_429_TEMPORARY" || code === "GATEWAY_RATE_LIMITED" || code.startsWith("GATEWAY_HTTP_5");
}
