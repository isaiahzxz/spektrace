import { parseScopeToken } from "@/lib/dashboard/scope";

export const SAVED_VIEW_VERSION = 1;

export const VIEW_DESTINATIONS = ["overview", "incidents", "patterns", "specs", "consumers", "history"] as const;
export type ViewDestination = (typeof VIEW_DESTINATIONS)[number];

export type SavedFilters = {
  service: string | null;
  environment: string | null;
  queue: "all" | "pending" | "triaged" | "history" | null;
  application: string | null;
  range: "day" | "week" | "month" | null;
  from: string | null;
  to: string | null;
};

export type SavedView = {
  id: string;
  name: string;
  destination: ViewDestination;
  filters: SavedFilters;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,60}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function emptyFilters(): SavedFilters {
  return { service: null, environment: null, queue: null, application: null, range: null, from: null, to: null };
}

export function filtersFromSearch(params: URLSearchParams, destination: ViewDestination): SavedFilters {
  const queueRaw = params.get("filter");
  const queue = queueRaw === "pending" || queueRaw === "triaged" || queueRaw === "history" || queueRaw === "all"
    ? queueRaw
    : destination === "incidents" || destination === "patterns" ? "all" : null;
  const rangeRaw = params.get("range");
  const range = rangeRaw === "day" || rangeRaw === "week" || rangeRaw === "month" ? rangeRaw : null;
  const from = params.get("from");
  const to = params.get("to");
  const fixed = from && to && DAY.test(from) && DAY.test(to);
  return {
    service: parseScopeToken(params.get("svc") ?? params.get("service")),
    environment: parseScopeToken(params.get("env") ?? params.get("environment")),
    queue,
    application: parseScopeToken(params.get("application")),
    range: fixed ? null : range,
    from: fixed ? from : null,
    to: fixed ? to : null,
  };
}

export function summarizeFilters(filters: SavedFilters): string[] {
  const queueLabel = filters.queue === "all" ? "Active" : filters.queue === "history" ? "Accepted" : filters.queue === "pending" ? "Pending" : filters.queue === "triaged" ? "Triaged" : null;
  return [
    filters.service ? `Service ${filters.service}` : "All services",
    filters.environment ? `Environment ${filters.environment}` : "All environments",
    queueLabel ? `Queue ${queueLabel}` : null,
    filters.application ? `Application ${filters.application}` : null,
    filters.from && filters.to ? `Fixed dates ${filters.from} to ${filters.to}` : null,
    !filters.from && filters.range ? `Rolling ${filters.range === "day" ? "24 hours" : filters.range === "week" ? "week" : "month"}` : null,
  ].filter((line): line is string => Boolean(line));
}

export function viewHref(view: SavedView): string {
  const params = new URLSearchParams();
  if (view.filters.service) params.set("svc", view.filters.service);
  if (view.filters.environment) params.set("env", view.filters.environment);
  if (view.filters.queue && view.filters.queue !== "all") params.set("filter", view.filters.queue);
  if (view.filters.application) params.set("application", view.filters.application);
  if (view.filters.from && view.filters.to) {
    params.set("from", view.filters.from);
    params.set("to", view.filters.to);
  } else if (view.filters.range && view.filters.range !== "month") {
    params.set("range", view.filters.range);
  }
  if (view.destination === "patterns") params.set("view", "patterns");
  if (view.destination === "consumers" || view.destination === "history" || view.destination === "specs") {
    if (view.filters.environment) params.set("environment", view.filters.environment);
    if (view.filters.service) params.set("service", view.filters.service);
  }
  const path = view.destination === "overview" ? "/dashboard"
    : view.destination === "specs" ? "/dashboard/specs"
      : view.destination === "consumers" ? "/dashboard/consumers"
        : view.destination === "history" ? "/dashboard/history"
          : "/dashboard/incidents";
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

export function destinationFromPath(pathname: string, view: string | null): ViewDestination {
  if (pathname.startsWith("/dashboard/specs")) return "specs";
  if (pathname.startsWith("/dashboard/consumers")) return "consumers";
  if (pathname.startsWith("/dashboard/history")) return "history";
  if (pathname.startsWith("/dashboard/incidents")) return view === "patterns" ? "patterns" : "incidents";
  return "overview";
}

function parseFilters(value: unknown): SavedFilters | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const queue = raw.queue === "all" || raw.queue === "pending" || raw.queue === "triaged" || raw.queue === "history" ? raw.queue : null;
  const range = raw.range === "day" || raw.range === "week" || raw.range === "month" ? raw.range : null;
  const from = typeof raw.from === "string" && DAY.test(raw.from) ? raw.from : null;
  const to = typeof raw.to === "string" && DAY.test(raw.to) ? raw.to : null;
  return {
    service: typeof raw.service === "string" ? parseScopeToken(raw.service) : null,
    environment: typeof raw.environment === "string" ? parseScopeToken(raw.environment) : null,
    queue,
    application: typeof raw.application === "string" ? parseScopeToken(raw.application) : null,
    range: from && to ? null : range,
    from: from && to ? from : null,
    to: from && to ? to : null,
  };
}

function parseView(value: unknown): SavedView | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !ID.test(raw.id)) return null;
  if (typeof raw.name !== "string" || !NAME.test(raw.name)) return null;
  if (!VIEW_DESTINATIONS.includes(raw.destination as ViewDestination)) return null;
  const filters = parseFilters(raw.filters);
  if (!filters) return null;
  return { id: raw.id, name: raw.name, destination: raw.destination as ViewDestination, filters };
}

export function parseSavedViewStore(raw: unknown): { views: SavedView[]; dropped: number } {
  if (!raw || typeof raw !== "object") return { views: [], dropped: 0 };
  const record = raw as { version?: unknown; views?: unknown };
  if (record.version !== SAVED_VIEW_VERSION || !Array.isArray(record.views)) return { views: [], dropped: 0 };
  const views: SavedView[] = [];
  let dropped = 0;
  for (const item of record.views) {
    const view = parseView(item);
    if (view) views.push(view);
    else dropped += 1;
  }
  return { views, dropped };
}

export function serializeSavedViews(views: SavedView[]): string {
  return JSON.stringify({ version: SAVED_VIEW_VERSION, views });
}

export function missingEnvironment(view: SavedView, environments: string[]): string | null {
  if (!view.filters.environment) return null;
  return environments.includes(view.filters.environment) ? null : view.filters.environment;
}

export function viewNameError(name: string): string | null {
  return NAME.test(name.trim()) ? null : "Use letters, numbers, spaces, and . _ -";
}
