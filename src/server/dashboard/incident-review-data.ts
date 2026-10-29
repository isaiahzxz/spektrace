import { getDashboardWorkspaceId } from "@/server/accounts/workspace";
import "server-only";
import { cache } from "react";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { getPrisma } from "@/lib/db";
import type { QueueFilter } from "@/lib/dashboard/incident-status";
import {
  toIncidentDetailView,
  toIncidentRowView,
  type IncidentDetailView,
  type IncidentRowView,
} from "@/lib/dashboard/incident-view-models";
import { incidentScopeWhere, type RecordScope } from "@/lib/dashboard/scope";
import { QUEUE_PAGE_SIZE, type QueueQuery } from "@/lib/dashboard/queue-query";
import { InternalConfigError } from "@/lib/internal-config";
import { getWorkspaceById } from "@/server/repositories/workspaces";
import {
  loadIncidentAiExplanation,
  type IncidentAiExplanationView,
} from "@/server/dashboard/incident-inference-data";

/** Must stay in sync with `statusCategory` (verified by integration tests). */
const FAILED_WHERE: Prisma.IncidentWhereInput = {
  OR: [{ status: "FAILED" }, { validationStatus: "ERROR" }],
};

export function filterWhere(filter: QueueFilter | "failed"): Prisma.IncidentWhereInput {
  switch (filter) {
    case "all":
      return { status: { not: "APPROVED" } };
    case "history":
      return { status: "APPROVED" };
    case "failed":
      return FAILED_WHERE;
    case "pending":
      return {
        NOT: FAILED_WHERE,
        OR: [
          { status: { in: ["RECEIVED", "VALIDATING"] } },
          { validationStatus: "NOT_RUN" },
        ],
      };
    case "triaged":
      return {
        status: { notIn: ["RECEIVED", "VALIDATING", "FAILED", "APPROVED"] },
        validationStatus: { in: ["PASSED", "MISMATCH", "UNSUPPORTED"] },
      };
  }
}

const ROW_SELECT = {
  id: true,
  httpMethod: true,
  requestPath: true,
  statusCode: true,
  status: true,
  validationStatus: true,
  validationEvidence: true,
  receivedAt: true,
} satisfies Prisma.IncidentSelect;

const DETAIL_SELECT = {
  ...ROW_SELECT,
  environment: true,
  apiKey: true,
  apiSpecId: true,
  source: true,
  sourceEventId: true,
  clientReference: true,
  sanitizedRequestBody: true,
  occurredAt: true,
  validatedAt: true,
  processingErrorCode: true,
  processingErrorMessage: true,
  apiSpec: {
    select: {
      id: true,
      name: true,
      version: true,
      openApiVersion: true,
      sourceFilename: true,
      sourceSha256: true,
      isActive: true,
    },
  },
} satisfies Prisma.IncidentSelect;

export type QueueCounts = Record<QueueFilter | "failed", number>;

export type IncidentQueuePage = {
  rows: IncidentRowView[];
  counts: QueueCounts;
  page: number;
  totalPages: number;
  pageSize: number;
};

export async function listWorkspaceIncidents(
  prisma: PrismaClient,
  workspaceId: string,
  filter: QueueFilter,
  requestedPage: number,
  scope: RecordScope = { service: null, environment: null },
): Promise<IncidentQueuePage> {
  const scoped = (where: Prisma.IncidentWhereInput): Prisma.IncidentWhereInput => ({
    AND: [{ workspaceId }, incidentScopeWhere(scope), where],
  });

  const [all, pending, triaged, failed, history] = await Promise.all([
    prisma.incident.count({ where: scoped(filterWhere("all")) }),
    prisma.incident.count({ where: scoped(filterWhere("pending")) }),
    prisma.incident.count({ where: scoped(filterWhere("triaged")) }),
    prisma.incident.count({ where: scoped(filterWhere("failed")) }),
    prisma.incident.count({ where: scoped(filterWhere("history")) }),
  ]);
  const counts: QueueCounts = { all, pending, triaged, failed, history };

  const total = counts[filter];
  const totalPages = Math.max(1, Math.ceil(total / QUEUE_PAGE_SIZE));
  const page = Math.min(Math.max(1, requestedPage), totalPages);

  const rows = await prisma.incident.findMany({
    where: scoped(filterWhere(filter)),
    orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * QUEUE_PAGE_SIZE,
    take: QUEUE_PAGE_SIZE,
    select: ROW_SELECT,
  });

  return {
    rows: rows.map(toIncidentRowView),
    counts,
    page,
    totalPages,
    pageSize: QUEUE_PAGE_SIZE,
  };
}

export async function getWorkspaceIncidentDetail(
  prisma: PrismaClient,
  workspaceId: string,
  incidentId: string,
): Promise<IncidentDetailView | null> {
  const [incident, bodyRows] = await Promise.all([
    prisma.incident.findFirst({
      where: { id: incidentId, workspaceId },
      select: DETAIL_SELECT,
    }),
    prisma.$queryRaw<Array<{ body_type: string | null }>>`
      SELECT jsonb_typeof(sanitized_request_body) AS body_type
      FROM incidents
      WHERE id = ${incidentId}::uuid AND workspace_id = ${workspaceId}::uuid
    `,
  ]);

  if (!incident) {
    return null;
  }
  return toIncidentDetailView(incident, bodyRows[0]?.body_type ?? null);
}

export type PilotWorkspace = { id: string; name: string };

export type IncidentReviewResult =
  | { kind: "not-configured" }
  | { kind: "workspace-not-found" }
  | { kind: "database-unavailable" }
  | {
      kind: "ok";
      workspace: PilotWorkspace;
      queue: IncidentQueuePage;
      detail:
        | { kind: "none" }
        | { kind: "unavailable" }
        | { kind: "found"; incident: IncidentDetailView; aiExplanation: IncidentAiExplanationView };
      loadedAt: string;
    };

function logFailure(scope: string, error: unknown) {
  const name = error instanceof Error ? error.name : "UnknownError";
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "none";
  console.error(`[dashboard] ${scope} failed (${name}, code ${code})`);
}

type WorkspaceLookup =
  | { kind: "ok"; workspace: PilotWorkspace }
  | { kind: "not-configured" }
  | { kind: "workspace-not-found" }
  | { kind: "database-unavailable" };

export const loadPilotWorkspace = cache(async (): Promise<WorkspaceLookup> => {
  let workspaceId: string;
  try {
    workspaceId = (await getDashboardWorkspaceId());
  } catch (error) {
    if (error instanceof InternalConfigError) return { kind: "not-configured" };
    throw error;
  }

  try {
    const workspace = await getWorkspaceById(getPrisma(), workspaceId);
    if (!workspace) return { kind: "workspace-not-found" };
    return { kind: "ok", workspace: { id: workspace.id, name: workspace.name } };
  } catch (error) {
    logFailure("workspace lookup", error);
    return { kind: "database-unavailable" };
  }
});

export async function loadIncidentReview(query: QueueQuery): Promise<IncidentReviewResult> {
  const lookup = await loadPilotWorkspace();
  if (lookup.kind !== "ok") return lookup;

  const workspaceId = lookup.workspace.id;

  try {
    const prisma = getPrisma();
    const selectedId = query.selected.kind === "id" ? query.selected.id : null;
    const [queue, detail, aiExplanation] = await Promise.all([
      listWorkspaceIncidents(prisma, workspaceId, query.filter, query.page, {
        service: query.service,
        environment: query.environment,
      }),
      selectedId
        ? getWorkspaceIncidentDetail(prisma, workspaceId, selectedId)
        : Promise.resolve(undefined),
      selectedId
        ? loadIncidentAiExplanation(prisma, workspaceId, selectedId)
        : Promise.resolve(null),
    ]);

    return {
      kind: "ok",
      workspace: lookup.workspace,
      queue,
      detail:
        query.selected.kind === "none"
          ? { kind: "none" }
          : detail
            ? {
                kind: "found",
                incident: detail,
                aiExplanation: aiExplanation ?? { state: "not-grouped" },
              }
            : { kind: "unavailable" },
      loadedAt: new Date().toISOString(),
    };
  } catch (error) {
    logFailure("incident review query", error);
    return { kind: "database-unavailable" };
  }
}
