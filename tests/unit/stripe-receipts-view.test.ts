import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseStripeReceiptFilters, stripeCheckState, stripeReceiptHref } from "@/lib/dashboard/stripe-receipts";
import { StripeReceiptList, StripeScopeNotice } from "@/components/dashboard/stripe-receipt-view";

const integrationId = "d5028e17-1b3f-48ed-8953-1551ae7444a1";
describe("Stripe receipt filters and presentation", () => {
  it("validates integration/page and refuses ambiguous query arrays", () => {
    expect(parseStripeReceiptFilters({ integration: integrationId, page: "2" }).success).toBe(true);
    for (const raw of [{ page: "0" }, { page: "10001" }, { integration: "not-an-id" }, { integration: [integrationId, integrationId] }, { page: ["1", "2"] }, { env: ["default", "staging"] }])
      expect(parseStripeReceiptFilters(raw).success).toBe(false);
  });
  it("preserves integration/page on list and detail links", () => {
    const id = "856ad287-cafb-4d9a-8506-1e373586b4fe";
    expect(stripeReceiptHref({ integrationId, page: 2 }, id)).toBe(`/dashboard/webhooks/stripe/${id}?integration=${integrationId}&page=2`);
    expect(stripeReceiptHref({ page: 1 })).toBe("/dashboard/webhooks/stripe");
  });
  it("never interprets passed/mismatch or unknown worker states as a supported Stripe verdict", () => {
    for (const state of ["PASSED", "MISMATCH", "UNSUPPORTED", "unknown"]) expect(stripeCheckState(state, "PUBLISHED")).toBe("Incomplete");
    expect(stripeCheckState("NOT_RUN", "PENDING")).toBe("Pending"); expect(stripeCheckState("NOT_RUN", "FAILED")).toBe("Failed");
    expect(stripeCheckState("NOT_RUN", null)).toBe("Incomplete");
  });
  it("makes empty/out-of-range and unsupported service scope explicit without invented environment mapping", () => {
    const empty = renderToStaticMarkup(createElement(StripeReceiptList, { rows: [], total: 0, filters: { page: 1 } }));
    expect(empty).toContain("No Stripe test receipts"); expect(empty).toContain("does not connect or enable");
    const outside = renderToStaticMarkup(createElement(StripeReceiptList, { rows: [], total: 21, filters: { integrationId, page: 3 } }));
    expect(outside).toContain("No Stripe receipts on this page"); expect(outside).toContain("Previous");
    const scope = renderToStaticMarkup(createElement(StripeScopeNotice, { filters: { integrationId, environment: "default", page: 1 } }));
    expect(scope).toContain("No unfiltered receipts are shown"); expect(scope).not.toContain("env=default");
    expect(scope).toContain(`integration=${integrationId}`);
  });
});
