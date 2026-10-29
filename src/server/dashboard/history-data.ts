import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { tallyCheckOutcomes, type CheckOutcomes } from "@/lib/dashboard/check-outcomes";
import { historyQueryScope, type HistoryRange } from "@/lib/dashboard/history-range";
import { seriesForInterval, type VolumePoint } from "@/lib/dashboard/incident-volume";
import { toIncidentRowView, type IncidentRowView } from "@/lib/dashboard/incident-view-models";
import { aggregateMismatchPatterns, type PatternSample, type PatternSeverity } from "@/lib/dashboard/mismatch-patterns";
import { getPrisma } from "@/lib/db";
import { loadPilotWorkspace } from "@/server/dashboard/incident-review-data";

const PAGE_SIZE = 8;
const PATTERN_CAP = 2000;

export type HistoryReport = {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  rows: IncidentRowView[];
  outcomes: CheckOutcomes;
  passedRate: number | null;
  supported: number;
  volume: VolumePoint[];
  patterns: PatternSample;
  patternLimited: boolean;
};

function cohortWhere(workspaceId: string, range: HistoryRange): Prisma.IncidentWhereInput {
  const scope = historyQueryScope(workspaceId, range);
  if (!scope) throw new Error("history range is not queryable");
  return scope as Prisma.IncidentWhereInput;
}

export async function loadHistoryReport(range: HistoryRange): Promise<
  | { kind: "ok"; report: HistoryReport }
  | { kind: "not-configured" }
  | { kind: "workspace-not-found" }
  | { kind: "database-unavailable" }
  | { kind: "invalid-range" }
> {
  if (!range.start || !range.endExclusive || range.error) return { kind: "invalid-range" };
  const lookup = await loadPilotWorkspace();
  if (lookup.kind !== "ok") return lookup;
  const where = cohortWhere(lookup.workspace.id, range);
  const prisma = getPrisma();

  try {
    const [total, statusRows, pageRows, patternRows, stamps, severities] = await Promise.all([
      prisma.incident.count({ where }),
      prisma.incident.groupBy({
        by: ["status", "validationStatus"],
        where,
        _count: { _all: true },
      }),
      prisma.incident.findMany({
        where,
        orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
        skip: (range.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: {
          id: true,
          httpMethod: true,
          requestPath: true,
          statusCode: true,
          status: true,
          validationStatus: true,
          validationEvidence: true,
          receivedAt: true,
        },
      }),
      prisma.incident.findMany({
        where,
        orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
        take: PATTERN_CAP,
        select: {
          id: true,
          httpMethod: true,
          requestPath: true,
          validationEvidence: true,
          apiSpec: { select: { id: true, name: true, version: true } },
        },
      }),
      prisma.incident.findMany({
        where,
        select: { receivedAt: true },
        take: 5000,
      }),
      prisma.patternSeverityAssignment.findMany({
        where: { workspaceId: lookup.workspace.id },
        select: { patternKey: true, severity: true },
      }),
    ]);

    const outcomes = tallyCheckOutcomes(
      statusRows.map((row) => ({
        status: row.status,
        validationStatus: row.validationStatus,
        count: row._count._all,
      })),
    );
    const supported = outcomes.passed + outcomes.mismatch;
    const severityMap = Object.fromEntries(severities.map((row) => [row.patternKey, row.severity as PatternSeverity]));
    return {
      kind: "ok",
      report: {
        total,
        page: range.page,
        pageSize: PAGE_SIZE,
        totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
        rows: pageRows.map(toIncidentRowView),
        outcomes,
        supported,
        passedRate: supported === 0 ? null : Math.round((outcomes.passed / supported) * 100),
        volume: seriesForInterval(
          stamps.map((row) => row.receivedAt),
          range.start,
          range.endExclusive,
        ),
        patterns: aggregateMismatchPatterns(
          patternRows.map((row) => ({
            id: row.id,
            httpMethod: row.httpMethod,
            requestPath: row.requestPath,
            validationEvidence: row.validationEvidence,
            spec: row.apiSpec,
          })),
          total,
          severityMap,
        ),
        patternLimited: total > PATTERN_CAP,
      },
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    console.error(`[dashboard] history query failed (${name})`);
    return { kind: "database-unavailable" };
  }
}
