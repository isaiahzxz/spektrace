import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { labelSchema } from "@/lib/integration-observations/contract";
import { parseHistoryRange } from "./history-range";
export const observationFilters = z
  .object({
    env: labelSchema.optional(),
    svc: labelSchema.optional(),
    provider: labelSchema.optional(),
    page: z.coerce.number().int().min(1).max(10000).default(1),
    from: z.string().max(10).optional(),
    to: z.string().max(10).optional(),
    finding: z
      .enum([
        "drift",
        "contract",
        "no-response",
        "pending",
        "incomplete",
        "match",
      ])
      .optional(),
    http: z.enum(["4xx", "5xx"]).optional(),
    notice: z.literal("legacy-consumers").optional(),
  })
  .superRefine((filters, ctx) => {
    if (filters.from !== undefined || filters.to !== undefined) {
      const range = parseHistoryRange({ from: filters.from, to: filters.to });
      if (range.error)
        ctx.addIssue({ code: "custom", message: range.error, path: ["from"] });
    }
  });
export type ObservationFilters = z.infer<typeof observationFilters>;
export function parseObservationFilters(
  raw: Record<string, string | string[] | undefined>,
) {
  const selected: Record<string, unknown> = {};
  for (const key of [
    "env",
    "svc",
    "provider",
    "page",
    "from",
    "to",
    "finding",
    "http",
    "notice",
  ]) {
    const value = raw[key];
    selected[key] = Array.isArray(value)
      ? value[0] || undefined
      : value || undefined;
  }
  return observationFilters.safeParse(selected);
}
export function observationHref(
  filters: ObservationFilters,
  overrides: Partial<ObservationFilters> = {},
) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...filters, ...overrides })) {
    if (value !== undefined && value !== "" && (key !== "page" || value !== 1))
      params.set(key, String(value));
  }
  return "/dashboard/observations" + (params.size ? "?" + params : "");
}
export function observationScope(
  workspaceId: string,
  filters: ObservationFilters,
) {
  return {
    workspaceId,
    ...(filters.env ? { environment: filters.env } : {}),
    ...(filters.svc ? { integrationKey: filters.svc } : {}),
    ...(filters.provider ? { providerKey: filters.provider } : {}),
  };
}
export function observationWhere(
  workspaceId: string,
  filters: ObservationFilters,
): Prisma.IntegrationObservationWhereInput {
  const where: Prisma.IntegrationObservationWhereInput = observationScope(
    workspaceId,
    filters,
  );
  if (filters.from && filters.to) {
    const range = parseHistoryRange({ from: filters.from, to: filters.to });
    if (range.error || !range.start || !range.endExclusive)
      throw Error("Invalid observation dates");
    where.receivedAt = { gte: range.start, lt: range.endExclusive };
  }
  if (filters.http) {
    where.resultKind = "HTTP";
    where.statusCode = {
      gte: filters.http === "4xx" ? 400 : 500,
      lt: filters.http === "4xx" ? 500 : 600,
    };
  }
  if (filters.finding === "no-response")
    where.resultKind = { in: ["TIMEOUT", "TRANSPORT", "ABORTED"] };
  if (filters.finding === "pending") where.processingState = "PENDING";
  const codes =
    filters.finding === "drift"
      ? ["DRIFT"]
      : filters.finding === "contract"
        ? ["CONTRACT_MISMATCH"]
        : filters.finding === "match"
          ? ["MATCH"]
          : filters.finding === "incomplete"
            ? ["INCOMPLETE", "UNSUPPORTED", "CAPTURE_OFF", "NO_BASELINE"]
            : [];
  if (codes.length) {
    where.processingState = "DONE";
    where.OR = codes.map((code) => ({
      detectorEvidence: { path: ["code"], equals: code },
    }));
  }
  // Keep mutually incompatible selectors empty rather than dropping either one.
  if (filters.finding === "no-response" && filters.http)
    where.AND = [{ resultKind: "HTTP" }, { resultKind: { not: "HTTP" } }];
  return where;
}
export function observationEmptyState(
  {
    total,
    scopeTotal,
    workspaceTotal,
    configuredCount,
    coverageCount,
  }: {
    total: number;
    scopeTotal: number;
    workspaceTotal: number;
    configuredCount: number;
    coverageCount: number;
  },
  filters: ObservationFilters,
) {
  if (total > 0 && filters.page > 1) return "page";
  if (scopeTotal > 0) return "filtered";
  if (configuredCount > 0 || coverageCount > 0) return "waiting";
  if (
    workspaceTotal > 0 ||
    filters.env ||
    filters.svc ||
    filters.provider ||
    filters.from ||
    filters.finding ||
    filters.http
  )
    return "filtered";
  return "setup";
}
