import "server-only";
import { incidentScopeWhere, type RecordScope } from "@/lib/dashboard/scope";
import { aggregateMismatchPatterns, type PatternSample, type PatternSeverity } from "@/lib/dashboard/mismatch-patterns";
import { getPrisma } from "@/lib/db";
import { loadPilotWorkspace } from "@/server/dashboard/incident-review-data";

export async function loadPatternBoard(scope: RecordScope): Promise<
  | { kind: "ok"; patterns: PatternSample }
  | { kind: "not-configured" }
  | { kind: "workspace-not-found" }
  | { kind: "database-unavailable" }
> {
  const lookup = await loadPilotWorkspace();
  if (lookup.kind !== "ok") return lookup;
  try {
    const prisma = getPrisma();
    const where = { workspaceId: lookup.workspace.id, ...incidentScopeWhere(scope) };
    const [rows, total, severities] = await Promise.all([
      prisma.incident.findMany({
        where,
        orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
        take: 200,
        select: {
          id: true,
          httpMethod: true,
          requestPath: true,
          validationEvidence: true,
          apiSpec: { select: { id: true, name: true, version: true } },
        },
      }),
      prisma.incident.count({ where }),
      prisma.patternSeverityAssignment.findMany({
        where: { workspaceId: lookup.workspace.id },
        select: { patternKey: true, severity: true },
      }),
    ]);
    return {
      kind: "ok",
      patterns: aggregateMismatchPatterns(
        rows.map((row) => ({
          id: row.id,
          httpMethod: row.httpMethod,
          requestPath: row.requestPath,
          validationEvidence: row.validationEvidence,
          spec: row.apiSpec,
        })),
        total,
        Object.fromEntries(severities.map((row) => [row.patternKey, row.severity as PatternSeverity])),
      ),
    };
  } catch {
    return { kind: "database-unavailable" };
  }
}
