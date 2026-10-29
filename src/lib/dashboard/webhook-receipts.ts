import { z } from "zod";

export type WebhookDisplayState = "Pending" | "Passed" | "Mismatch" | "Incomplete" | "Failed";
export function webhookDisplayState(validation: string, dispatch: string | null): WebhookDisplayState {
  if (validation === "PASSED") return "Passed";
  if (validation === "MISMATCH") return "Mismatch";
  if (validation === "ERROR") return "Failed";
  if (validation === "UNSUPPORTED") return "Incomplete";
  if (validation !== "NOT_RUN") return "Incomplete";
  if (dispatch === "FAILED") return "Failed";
  return dispatch === "PENDING" || dispatch === "CLAIMED" || dispatch === "PUBLISHED" ? "Pending" : "Incomplete";
}

const token = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export function parseWebhookFilters(raw: Record<string, string | string[] | undefined>) {
  const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
  return z.object({ environment: token.optional(), service: token.optional(), page: z.coerce.number().int().min(1).max(10000) }).safeParse({
    environment: first(raw.env) || first(raw.environment) || undefined,
    service: first(raw.svc) || first(raw.service) || undefined,
    page: first(raw.page) || "1",
  });
}
export type WebhookFilters = { environment?: string; service?: string; page: number };
export function webhookHref(filters: WebhookFilters, receiptId?: string): string {
  const query = new URLSearchParams();
  if (filters.environment) query.set("env", filters.environment);
  if (filters.service) query.set("svc", filters.service);
  if (filters.page > 1) query.set("page", String(filters.page));
  const route = receiptId ? `/dashboard/webhooks/${receiptId}` : "/dashboard/webhooks";
  return query.size ? `${route}?${query}` : route;
}
