export function decideImport(existing: { sourceSha256: string; version: string } | null, incoming: { sourceSha256: string; version: string }) {
  if (!existing) return "create" as const;
  if (existing.sourceSha256 === incoming.sourceSha256) return "replay" as const;
  if (existing.version === incoming.version) return "conflict" as const;
  return "create" as const;
}

export function decideActivation(
  active: { id: string; revisionSequence: number } | null,
  target: { id: string; revisionSequence: number },
) {
  if (active?.id === target.id) return "replay" as const;
  if (active && active.revisionSequence > target.revisionSequence) return "stale" as const;
  if (active && active.revisionSequence === target.revisionSequence && active.id !== target.id) return "ambiguous" as const;
  return "activate" as const;
}

export type ObservedHealth = "Observed mismatches" | "No mismatches observed in captured requests" | "No captured data" | "Checks incomplete";

export function observedHealth(input: { captured: number; mismatches: number; supported: number; incomplete: number }): ObservedHealth {
  if (input.captured === 0) return "No captured data";
  if (input.mismatches > 0) return "Observed mismatches";
  if (input.supported === 0 && input.incomplete > 0) return "Checks incomplete";
  if (input.supported > 0 && input.mismatches === 0) return "No mismatches observed in captured requests";
  return "Checks incomplete";
}

export type IncidentRelation = "Related field mismatch" | "Observed after activation" | "none";

export function relateIncident(input: {
  method: string;
  path: string;
  pinnedSpecId: string | null;
  findingPointers: string[];
  receivedAt: Date;
  changedFields: Array<{ method: string; path: string; pointer: string; revisions: string[] }>;
  activatedAt: Date | null;
}): IncidentRelation {
  const exact = input.changedFields.some((change) =>
    change.method === input.method &&
    change.path === input.path &&
    input.pinnedSpecId !== null &&
    change.revisions.includes(input.pinnedSpecId) &&
    input.findingPointers.some((pointer) => pointer === change.pointer || pointer.startsWith(`${change.pointer}/`)),
  );
  if (exact) return "Related field mismatch";
  if (input.activatedAt && input.receivedAt >= input.activatedAt) return "Observed after activation";
  return "none";
}
