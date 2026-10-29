const MAX_CHARS = 65_536;
const MAX_DEPTH = 20;

export type CandidateInspection =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

function depth(value: unknown, level: number): number {
  if (level > MAX_DEPTH) return level;
  if (value === null || typeof value !== "object") return level;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.reduce((max, child) => Math.max(max, depth(child, level + 1)), level);
}

export function inspectCandidate(text: string): CandidateInspection {
  if (text.length > MAX_CHARS) {
    return { ok: false, reason: "The candidate is larger than 64 KB." };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "The candidate is not valid JSON." };
  }
  if (depth(value, 1) > MAX_DEPTH) {
    return { ok: false, reason: "The candidate is nested more than 20 levels." };
  }
  return { ok: true, value };
}
