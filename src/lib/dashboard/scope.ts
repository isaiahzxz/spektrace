export const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type RecordScope = {
  service: string | null;
  environment: string | null;
};

export function parseScopeToken(value: string | null | undefined): string | null {
  return value && SCOPE_PATTERN.test(value) ? value : null;
}

/** Incident rows that belong to the URL scope. Absent fields stay unfiltered. */
export function incidentScopeWhere(scope: RecordScope): { apiKey?: string; environment?: string } {
  return {
    ...(scope.service ? { apiKey: scope.service } : {}),
    ...(scope.environment ? { environment: scope.environment } : {}),
  };
}

const KEPT = ["svc", "service", "range", "from", "to", "filter", "state", "application", "view"] as const;

/** Replace the environment on the current page without dropping the date range or queue filter. */
export function environmentHref(pathname: string, current: URLSearchParams, environment: string | null): string {
  const next = new URLSearchParams();
  for (const key of KEPT) {
    const value = current.get(key);
    if (value) next.set(key, value);
  }
  const service = parseScopeToken(current.get("svc") ?? current.get("service"));
  if (service) {
    next.set("svc", service);
    if (pathname.startsWith("/dashboard/consumers") || pathname.startsWith("/dashboard/history") || pathname.startsWith("/dashboard/specs")) {
      next.set("service", service);
    }
  }
  next.delete("page");
  next.delete("incident");
  next.delete("inspect");
  if (environment) {
    next.set("env", environment);
    if (pathname.startsWith("/dashboard/consumers") || pathname.startsWith("/dashboard/history") || pathname.startsWith("/dashboard/specs")) {
      next.set("environment", environment);
    }
  }
  const search = next.toString();
  return search ? `${pathname}?${search}` : pathname;
}
