import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseMemberPage, webhookGroupHref } from "@/lib/dashboard/webhook-groups";
import { WebhookGroupList, GroupingNote, WebhookViews } from "@/components/dashboard/webhook-groups-view";
describe("webhook group navigation and disclosures", () => {
  it("preserves scope and group page separately from member page", () => {
    const filters = { page: 2, environment: "default", service: "payments" };
    expect(webhookGroupHref(filters, "group", 3)).toBe("/dashboard/webhooks/groups/group?env=default&svc=payments&page=2&members=3");
    expect(webhookGroupHref(filters)).toBe("/dashboard/webhooks/groups?env=default&svc=payments&page=2");
    expect(parseMemberPage(undefined).data).toBe(1);
    for (const value of ["0", "-1", "1.5", "Infinity", "10001"]) expect(parseMemberPage(value).success).toBe(false);
  });
  it("renders honest empty and uncertainty states with selected view semantics", () => {
    expect(renderToStaticMarkup(createElement(WebhookGroupList, { rows: [], total: 0, filters: { page: 1 } }))).toContain("No drift groups in this scope");
    expect(renderToStaticMarkup(createElement(GroupingNote))).toContain("do not establish a shared root cause");
    const nav = renderToStaticMarkup(createElement(WebhookViews, { filters: { page: 2, environment: "default" }, active: "groups" }));
    expect(nav).toContain('aria-current="page"'); expect(nav).toContain("Drift groups"); expect(nav).toContain("?env=default");
  });
});
