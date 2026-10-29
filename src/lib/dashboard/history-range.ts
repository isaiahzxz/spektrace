import { parseScopeToken } from "@/lib/dashboard/scope";

export type HistoryStateFilter = "all" | "review" | "accepted";

export type HistoryRange = {
  from: string;
  to: string;
  page: number;
  state: HistoryStateFilter;
  service: string | null;
  environment: string | null;
  error: string | null;
  start: Date | null;
  endExclusive: Date | null;
};

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function utcDay(value: Date) {
  return value.toISOString().slice(0, 10);
}

export function parseUtcDay(value: string): Date | null {
  const match = DAY.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

function nextUtcDay(value: Date) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() + 1));
}

export function defaultHistoryDays(now: Date) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 6);
  return { from: utcDay(start), to: utcDay(end) };
}

export function parseHistoryRange(
  params: Record<string, string | string[] | undefined>,
  now = new Date(),
): HistoryRange {
  const fallback = defaultHistoryDays(now);
  const rawFrom = first(params.from);
  const rawTo = first(params.to);
  const from = rawFrom ?? fallback.from;
  const to = rawTo ?? fallback.to;
  const rawPage = Number.parseInt(first(params.page) ?? "1", 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.min(rawPage, 10_000) : 1;
  const rawState = first(params.state);
  const state: HistoryStateFilter = rawState === "review" || rawState === "accepted" ? rawState : "all";
  const service = parseScopeToken(first(params.svc) ?? first(params.service));
  const environment = parseScopeToken(first(params.env) ?? first(params.environment));
  const scope = { service, environment };

  if ((rawFrom && !rawTo) || (!rawFrom && rawTo)) {
    return { from, to, page, state, ...scope, error: "Enter both a start date and an end date.", start: null, endExclusive: null };
  }
  const start = parseUtcDay(from);
  const end = parseUtcDay(to);
  if (!start || !end) {
    return { from, to, page, state, ...scope, error: "Use dates in YYYY-MM-DD.", start: null, endExclusive: null };
  }
  if (start.getTime() > end.getTime()) {
    return { from, to, page, state, ...scope, error: "The start date is after the end date.", start: null, endExclusive: null };
  }
  return { from, to, page, state, ...scope, error: null, start, endExclusive: nextUtcDay(end) };
}

/** Inclusive start, exclusive next-day end. Shared by every historical module. */
export function historyQueryScope(workspaceId: string, range: HistoryRange) {
  if (!range.start || !range.endExclusive || range.error) return null;
  const status =
    range.state === "review"
      ? { in: ["NEEDS_REVIEW", "DRAFT_READY"] }
      : range.state === "accepted"
        ? ("APPROVED" as const)
        : undefined;
  return {
    workspaceId,
    receivedAt: { gte: range.start, lt: range.endExclusive },
    ...(status ? { status } : {}),
    ...(range.service ? { apiKey: range.service } : {}),
    ...(range.environment ? { environment: range.environment } : {}),
  };
}

export function receivedDuringInterval(receivedAt: Date, start: Date, endExclusive: Date) {
  const time = receivedAt.getTime();
  return time >= start.getTime() && time < endExclusive.getTime();
}

export function historyHref(
  range: Pick<HistoryRange, "from" | "to" | "page" | "state" | "service" | "environment">,
  overrides: Partial<Pick<HistoryRange, "from" | "to" | "page" | "state" | "service" | "environment">> = {},
) {
  const params = new URLSearchParams();
  params.set("from", overrides.from ?? range.from);
  params.set("to", overrides.to ?? range.to);
  const page = overrides.page ?? range.page;
  const state = overrides.state ?? range.state;
  const service = overrides.service !== undefined ? overrides.service : range.service;
  const environment = overrides.environment !== undefined ? overrides.environment : range.environment;
  if (page > 1) params.set("page", String(page));
  if (state !== "all") params.set("state", state);
  if (service) {
    params.set("svc", service);
    params.set("service", service);
  }
  if (environment) {
    params.set("env", environment);
    params.set("environment", environment);
  }
  return `/dashboard/history?${params.toString()}`;
}
