export type PayloadDiffRow = { kind: "context" | "removed" | "added"; text: string };
export type PayloadDiff = { status: "unchanged" } | { status: "limited" } | { status: "changed"; rows: PayloadDiffRow[] };

export function buildPayloadDiff(originalText: string, candidateText: string): PayloadDiff {
  if (originalText === candidateText) return { status: "unchanged" };
  if (originalText.length > 65_536 || candidateText.length > 65_536) return { status: "limited" };
  const original = originalText.replace(/\r\n/g, "\n").split("\n");
  const candidate = candidateText.replace(/\r\n/g, "\n").split("\n");
  if (original.length > 300 || candidate.length > 300) return { status: "limited" };
  const lengths = Array.from({ length: original.length + 1 }, () => new Uint16Array(candidate.length + 1));
  for (let i = original.length - 1; i >= 0; i--) {
    for (let j = candidate.length - 1; j >= 0; j--) {
      lengths[i]![j] = original[i] === candidate[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  const rows: PayloadDiffRow[] = [];
  let i = 0; let j = 0;
  while (i < original.length || j < candidate.length) {
    if (i < original.length && j < candidate.length && original[i] === candidate[j]) {
      rows.push({ kind: "context", text: original[i++]! }); j++;
    } else if (i < original.length && (j >= candidate.length || lengths[i + 1]![j]! >= lengths[i]![j + 1]!)) {
      rows.push({ kind: "removed", text: original[i++]! });
    } else rows.push({ kind: "added", text: candidate[j++]! });
  }
  return rows.some(row => row.kind !== "context") ? { status: "changed", rows } : { status: "unchanged" };
}
