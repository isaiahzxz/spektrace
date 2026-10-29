import { AGENT_EVIDENCE_LIMITS } from "@/lib/agent-evidence/limits";

const FORBIDDEN_PATTERNS: Array<{ code: string; pattern: RegExp }> = [
  { code: "PAN_LIKE_SEQUENCE", pattern: /\b(?:\d[ -]?){13,19}\b/ },
  { code: "BEARER_TOKEN", pattern: /\bbearer\s+[a-z0-9._-]{8,}\b/i },
  { code: "AWS_KEY_LIKE", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { code: "PRIVATE_KEY_MARKER", pattern: /-----BEGIN [A-Z ]+ PRIVATE KEY-----/ },
  { code: "JWT_LIKE", pattern: /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9._-]{10,}\./ },
];

export type OutboundScanResult =
  | { safe: true }
  | { safe: false; code: string };

export function scanSerializedBundleForLeaks(serializedUtf8: string): OutboundScanResult {
  if (serializedUtf8.length > AGENT_EVIDENCE_LIMITS.maxBundleUtf8Bytes) {
    return { safe: false, code: "BUNDLE_SIZE_EXCEEDED" };
  }

  for (const { code, pattern } of FORBIDDEN_PATTERNS) {
    if (pattern.test(serializedUtf8)) {
      return { safe: false, code };
    }
  }

  return { safe: true };
}
