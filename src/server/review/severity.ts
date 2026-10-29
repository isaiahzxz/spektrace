import { ActorType, AuditEventType, type PrismaClient } from "@/generated/prisma/client";
import { appendAuditLog } from "@/lib/audit/append-audit-log";
import { LOCAL_PILOT_ACTOR } from "@/server/review/correction";

export const SEVERITIES = ["CRITICAL", "HIGH", "LOW", "UNRATED"] as const;
export type PatternSeverity = (typeof SEVERITIES)[number];

export function isPatternSeverity(value: string): value is PatternSeverity {
  return (SEVERITIES as readonly string[]).includes(value);
}

export async function assignPatternSeverity(
  db: PrismaClient,
  workspaceId: string,
  input: { patternKey: string; severity: PatternSeverity },
) {
  if (input.patternKey.includes("\u0000")) {
    return { ok: false as const, detail: "That pattern identity cannot be stored." };
  }
  return db.$transaction(async (tx) => {
    const existing = await tx.patternSeverityAssignment.findUnique({
      where: { workspaceId_patternKey: { workspaceId, patternKey: input.patternKey } },
    });
    if (existing?.severity === input.severity) {
      return { ok: true as const, detail: "That severity is already recorded." };
    }
    await tx.patternSeverityAssignment.upsert({
      where: { workspaceId_patternKey: { workspaceId, patternKey: input.patternKey } },
      create: {
        workspaceId,
        patternKey: input.patternKey,
        severity: input.severity,
        provenance: "manual",
        actorId: LOCAL_PILOT_ACTOR,
      },
      update: {
        severity: input.severity,
        provenance: "manual",
        actorId: LOCAL_PILOT_ACTOR,
      },
    });
    await appendAuditLog(tx, {
      workspaceId,
      eventType: AuditEventType.PATTERN_SEVERITY_SET,
      actorType: ActorType.HUMAN,
      actorId: LOCAL_PILOT_ACTOR,
      metadata: {
        patternKey: input.patternKey,
        severity: input.severity,
        provenance: "manual",
        limit: "Human assignment by the local pilot operator. Not inferred from frequency or a schema keyword.",
      },
    });
    return { ok: true as const, detail: "Severity saved." };
  });
}
