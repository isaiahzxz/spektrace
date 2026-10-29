import { z } from "zod";
import { type WebhookFilters } from "@/lib/dashboard/webhook-receipts";

export function parseMemberPage(raw: string | string[] | undefined) {
  return z.coerce.number().int().min(1).max(10000).safeParse(Array.isArray(raw) ? raw[0] : raw || "1");
}
export function webhookGroupHref(filters: WebhookFilters, groupId?: string, memberPage = 1) {
  const query = new URLSearchParams();
  if (filters.environment) query.set("env", filters.environment);
  if (filters.service) query.set("svc", filters.service);
  if (filters.page > 1) query.set("page", String(filters.page));
  if (groupId && memberPage > 1) query.set("members", String(memberPage));
  const route = groupId ? `/dashboard/webhooks/groups/${groupId}` : "/dashboard/webhooks/groups";
  return query.size ? `${route}?${query}` : route;
}
