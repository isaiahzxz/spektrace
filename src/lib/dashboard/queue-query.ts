import type { QueueFilter } from "@/lib/dashboard/incident-status";

export const QUEUE_PATH = "/dashboard/incidents";
export const QUEUE_PAGE_SIZE = 25;
const MAX_PAGE = 10_000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SelectedIncidentParam =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "id"; id: string };

export type VolumeRange = "day" | "week" | "month";

export type QueueView = "queue" | "patterns";

export type QueueQuery = {
  filter: QueueFilter;
  page: number;
  selected: SelectedIncidentParam;
  inspect: boolean;
  range: VolumeRange;
  service: string | null;
  environment: string | null;
  view: QueueView;
};

type RawSearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parseQueueQuery(params: RawSearchParams): QueueQuery {
  const rawFilter = first(params.filter);
  const filter: QueueFilter =
    rawFilter === "pending" || rawFilter === "triaged" || rawFilter === "history" ? rawFilter : "all";

  const rawPage = Number.parseInt(first(params.page) ?? "1", 10);
  const page =
    Number.isFinite(rawPage) && rawPage >= 1 ? Math.min(rawPage, MAX_PAGE) : 1;

  const rawIncident = first(params.incident);
  const selected: SelectedIncidentParam = !rawIncident
    ? { kind: "none" }
    : UUID_PATTERN.test(rawIncident)
      ? { kind: "id", id: rawIncident.toLowerCase() }
      : { kind: "invalid" };

  const rawRange = first(params.range);
  const range: VolumeRange = rawRange === "day" || rawRange === "week" || rawRange === "month" ? rawRange : "month";
  const scopePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
  const rawService = first(params.svc);
  const rawEnvironment = first(params.env);
  const service = rawService && scopePattern.test(rawService) ? rawService : null;
  const environment = rawEnvironment && scopePattern.test(rawEnvironment) ? rawEnvironment : null;
  const view: QueueView = first(params.view) === "patterns" ? "patterns" : "queue";

  return { filter, page, selected, inspect: first(params.inspect) === "1", range, service, environment, view };
}

export function buildQueueHref(
  query: QueueQuery,
  overrides: Partial<{
    filter: QueueFilter;
    page: number;
    incidentId: string | null;
    inspect: boolean;
    range: VolumeRange;
    service: string | null;
    environment: string | null;
    view: QueueView;
  }> = {},
  basePath: string = QUEUE_PATH,
): string {
  const filter = overrides.filter ?? query.filter;
  const page = overrides.page ?? query.page;
  const incidentId =
    overrides.incidentId !== undefined
      ? overrides.incidentId
      : query.selected.kind === "id"
        ? query.selected.id
        : null;
  const inspect = overrides.inspect ?? query.inspect;
  const range = overrides.range ?? query.range;
  const service = overrides.service !== undefined ? overrides.service : query.service;
  const environment = overrides.environment !== undefined ? overrides.environment : query.environment;
  const view = overrides.view ?? query.view;

  const params = new URLSearchParams();
  if (filter !== "all") params.set("filter", filter);
  if (page > 1) params.set("page", String(page));
  if (incidentId) params.set("incident", incidentId);
  if (inspect) params.set("inspect", "1");
  if (range !== "month") params.set("range", range);
  if (service) params.set("svc", service);
  if (environment) params.set("env", environment);
  if (view === "patterns") params.set("view", "patterns");
  const search = params.toString();
  return search ? `${basePath}?${search}` : basePath;
}

export function shortIncidentId(id: string): string {
  return id.slice(0, 8);
}

/** Deterministic UTC formatting so server and browser render the same text. */
export function formatUtc(value: Date | string | null): string | null {
  if (!value) return null;
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return null;
  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}
