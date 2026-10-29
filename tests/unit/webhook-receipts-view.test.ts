import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { webhookDisplayState, parseWebhookFilters, webhookHref } from "@/lib/dashboard/webhook-receipts";
import { WebhookAcceptanceNote, WebhookReceiptInspection, WebhookReceiptList } from "@/components/dashboard/webhook-receipt-view";
import type { WebhookReceiptDetail } from "@/server/dashboard/webhook-receipts";

describe("accepted webhook display states", () => {
  it("keeps acceptance separate from validation and surfaces terminal job failures", () => {
    expect(webhookDisplayState("NOT_RUN", "PENDING")).toBe("Pending");
    expect(webhookDisplayState("NOT_RUN", "PUBLISHED")).toBe("Pending");
    expect(webhookDisplayState("NOT_RUN", "FAILED")).toBe("Failed");
    expect(webhookDisplayState("NOT_RUN", null)).toBe("Incomplete");
    expect(webhookDisplayState("PASSED", "FAILED")).toBe("Passed");
    expect(webhookDisplayState("MISMATCH", "PUBLISHED")).toBe("Mismatch");
    expect(webhookDisplayState("UNSUPPORTED", "PUBLISHED")).toBe("Incomplete");
    expect(webhookDisplayState("ERROR", "PUBLISHED")).toBe("Failed");
    expect(webhookDisplayState("future_status", "PUBLISHED")).toBe("Incomplete");
  });
  it("validates scope and page and preserves both on receipt/back links", () => {
    const parsed = parseWebhookFilters({ env: "staging", svc: "payments", page: "2" });
    expect(parsed.success).toBe(true); if (!parsed.success) throw new Error("Expected valid filters");
    expect(webhookHref(parsed.data, "receipt")).toBe("/dashboard/webhooks/receipt?env=staging&svc=payments&page=2");
    for (const raw of [{ env: "../default" }, { page: "Infinity" }, { page: "0" }, { page: "1.1" }, { svc: "<script>" }])
      expect(parseWebhookFilters(raw).success).toBe(false);
  });
});

describe("receipt review markup", () => {
  it("shows the acceptance caveat and an explicit empty state", () => {
    expect(renderToStaticMarkup(createElement(WebhookAcceptanceNote))).toContain("Accepted for validation. Business processing is not confirmed.");
    const html = renderToStaticMarkup(createElement(WebhookReceiptList, { rows: [], total: 0, filters: { page: 1 } }));
    expect(html).toContain("No accepted webhooks in this scope"); expect(html).not.toContain("No incidents");
  });
  it("renders sanitized JSON as text and compares expected and received types", () => {
    const receipt: WebhookReceiptDetail = { id: "e12279bc-8c21-4d63-a411-f2744c56e579", receivedAt: "2026-10-22T00:00:00.000Z",
      service: "synthetic-webhook-payments", environment: "default", operationPath: "/payments", state: "Mismatch", validatedAt: "2026-10-22T00:00:01.000Z",
      specId: null, specLabel: "Synthetic payments 1.0.0", payload: '{"amount":"<script>unsafe</script>"}', omissions: ["email"], policy: "synthetic-payments@1",
      sourceSha256: null, reasonCode: "SCHEMA_MISMATCH", selectionLabel: "Active at acceptance · runtime unverified", integrityNote: null,
      senderVerification: null, verificationLabel: "Not verified · unsigned synthetic fixture",
      driftGroup: null, groupingLabel: "Not evaluated by this grouping version",
      findings: [{ path: "/amount", rule: "type", expected: "integer", received: "string", missingProperty: null }] };
    const html = renderToStaticMarkup(createElement(WebhookReceiptInspection, { receipt }));
    expect(html).toContain("Expected"); expect(html).toContain("integer"); expect(html).toContain("Received"); expect(html).toContain("string");
    expect(html).toContain("Omitted fields: email"); expect(html).toContain("&lt;script&gt;"); expect(html).not.toContain("<script>");
    expect(html).not.toContain("Accept tested correction");
  });
});
