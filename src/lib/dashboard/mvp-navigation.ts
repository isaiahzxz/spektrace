import { buildQueueHref, parseQueueQuery } from "./queue-query";
export type RawParams = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;
export const PRIMARY_NAV = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/integrations", label: "Integrations" },
  { href: "/dashboard/observations", label: "Observations" },
] as const;
export function primaryDestination(path: string) {
  if(path === "/dashboard") return "/dashboard";
  if (
    path.startsWith("/dashboard/integrations") ||
    path.startsWith("/dashboard/onboarding") ||
    path.startsWith("/dashboard/specs") ||
    path.startsWith("/dashboard/webhooks")
  )
    return "/dashboard/integrations";
  if (
    path.startsWith("/dashboard/settings") ||
    path.startsWith("/dashboard/audit") ||
    path.startsWith("/dashboard/history") ||
    path.startsWith("/dashboard/support")
  )
    return "/dashboard/settings";
  return "/dashboard/observations";
}
export function dashboardDestination(raw: RawParams) {
  if (
    raw.incident !== undefined ||
    raw.fixture !== undefined ||
    first(raw.inspect) === "1" ||
    first(raw.view) === "patterns" ||
    raw.filter !== undefined
  ) {
    const query = parseQueueQuery(raw);
    const href = new URL(
      buildQueueHref(query, {}, "/dashboard/incidents"),
      "http://local",
    );
    if (query.selected.kind === "invalid")
      href.searchParams.set("incident", "invalid");
    const fixture = first(raw.fixture);
    if (fixture && /^[a-z-]{1,32}$/.test(fixture))
      href.searchParams.set("fixture", fixture);
    return href.pathname + href.search;
  }
  return Object.keys(raw).length ? coreCompatibilityHref(raw, "overview") : "/dashboard";
}
export function coreCompatibilityHref(
  raw: RawParams,
  source: "overview" | "consumers" | "specs",
) {
  const params = new URLSearchParams();
  for (const [key, old] of [
    ["svc", "service"],
    ["env", "environment"],
    ["from", "from"],
    ["to", "to"],
  ] as const) {
    const value = first(raw[key]) ?? first(raw[old]);
    if (value !== undefined && value.length <= 128) params.set(key, value);
  }
  if (source === "consumers") params.set("notice", "legacy-consumers");
  const path =
    source === "specs" ? "/dashboard/integrations" : "/dashboard/observations";
  return (
    path +
    (params.size ? "?" + params.toString() : "") +
    (source === "specs" ? "#request-contracts" : "")
  );
}
