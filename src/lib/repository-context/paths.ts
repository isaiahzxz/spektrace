import { REPOSITORY_CONTEXT_LIMITS } from "@/lib/repository-context/config";

const BLOCKED_PATH_SEGMENTS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  "vendor",
  "__pycache__",
  "coverage",
  ".turbo",
]);

const BLOCKED_BASENAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);

const BLOCKED_SUFFIXES = [
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".crt",
  ".cer",
  ".der",
  ".min.js",
  ".min.css",
  ".map",
  ".lock",
];

export type NormalizedRelativePath =
  | { ok: true; path: string }
  | { ok: false; code: string };

export function normalizeRelativePath(input: string): NormalizedRelativePath {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, code: "PATH_EMPTY" };
  }
  if (trimmed.length > REPOSITORY_CONTEXT_LIMITS.maxRelativePathLength) {
    return { ok: false, code: "PATH_TOO_LONG" };
  }
  if (trimmed.startsWith("/") || trimmed.startsWith("\\") || /^[a-zA-Z]:/.test(trimmed)) {
    return { ok: false, code: "PATH_ABSOLUTE" };
  }
  if (trimmed.includes("\0")) {
    return { ok: false, code: "PATH_INVALID" };
  }

  const rawSegments = trimmed.replace(/\\/g, "/").split("/");
  const segments: string[] = [];
  for (const segment of rawSegments) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      return { ok: false, code: "PATH_TRAVERSAL" };
    }
    segments.push(segment);
  }

  if (segments.length === 0) {
    return { ok: false, code: "PATH_EMPTY" };
  }

  const normalized = segments.join("/");
  const lower = normalized.toLowerCase();
  const basename = segments[segments.length - 1] ?? "";

  if (BLOCKED_BASENAMES.has(basename) || basename.startsWith(".env.")) {
    return { ok: false, code: "PATH_BLOCKED" };
  }
  for (const segment of segments) {
    if (BLOCKED_PATH_SEGMENTS.has(segment.toLowerCase())) {
      return { ok: false, code: "PATH_BLOCKED" };
    }
  }
  for (const suffix of BLOCKED_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      return { ok: false, code: "PATH_BLOCKED" };
    }
  }

  return { ok: true, path: normalized };
}

export function pathAllowedByPrefix(
  normalizedPath: string,
  allowedPrefixes: string[],
): boolean {
  for (const prefix of allowedPrefixes) {
    const normalizedPrefix = prefix.replace(/\\/g, "/").replace(/\/$/, "");
    if (normalizedPrefix === "") {
      continue;
    }
    if (normalizedPath === normalizedPrefix || normalizedPath.startsWith(`${normalizedPrefix}/`)) {
      return true;
    }
  }
  return false;
}
