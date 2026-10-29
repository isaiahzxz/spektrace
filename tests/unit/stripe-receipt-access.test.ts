import { afterEach, describe, expect, it, vi } from "vitest";
import StripeReceiptsPage from "@/app/dashboard/webhooks/stripe/page";
import StripeReceiptPage from "@/app/dashboard/webhooks/stripe/[receiptId]/page";

afterEach(() => vi.unstubAllEnvs());
describe("Stripe receipt page access boundary", () => {
  it("refuses production requests before rendering workspace or receipt data", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => StripeReceiptsPage({ searchParams: Promise.resolve({}) })).toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(() => StripeReceiptPage({ params: Promise.resolve({ receiptId: "856ad287-cafb-4d9a-8506-1e373586b4fe" }), searchParams: Promise.resolve({}) })).toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  });
});
