# Stripe receipt review

The local dashboard now has **Accepted webhooks → Stripe receipts**, with a list and individual receipt pages. The routes are `/dashboard/webhooks/stripe` and `/dashboard/webhooks/stripe/[receiptId]`.

This is read-only and development-only. No credentials, schema configuration, replay, correction, approval, AI or notification controls are added. Stripe receipt ingestion and worker behavior are unchanged; there is no database migration.

## What appears

The list shows original event reference/type, acceptance time, configured integration, check state and View receipt. It supports integration UUID filtering, stable ordering and 20 receipts per page. Narrow screens use a stacked list. List/detail/back/pagination retain integration/page scope. Pending rows refresh every four seconds while visible; stored results do not continue polling.

Details show acceptance/event times, reported Stripe API version, receipt/integration references, strictly parsed selected field shapes, supported verification timestamps and the recorded incomplete-check reason. All payload values remain omitted. Signature verification establishes configured-secret possession, not independent Stripe/customer identity. A `payment_intent.succeeded` event is not shown as a passing contract check or business success. The contract panel explicitly says **Contract not configured**.

No service or deployment environment is recorded in the Stripe model. An inherited service/environment filter therefore shows an unsupported-scope notice and no unfiltered receipts. The user may deliberately clear that scope; test mode is never relabeled as an environment.

Unknown protection/verification/evidence JSON and raw job errors are not displayed or dumped. Unsupported or inconsistent provenance does not produce a verified-signature claim. Receipt queries are scoped by workspace and optional integration; unknown/foreign IDs share an unavailable state. Store failures are distinct from empty results. Both routes reject production rendering before loading workspace/receipt data.

## Repeatable verification

Use `npm run verify:synthetic-webhook -- --stripe-view --stripe-receipts --webhook-view --webhook-groups-view --webhook-signing --webhook-grouping --webhook-corpus --webhook-revision --stripe-view-controls --unit --build`.

This creates and drops an owned disposable database. Do not run broad integration/reset helpers against shared development or test databases. AI and proposals stay disabled. The three new unsafe-source controls intentionally remove list/detail workspace boundaries or expose unknown stored shape data; each must fail its intended assertion without changing the application's source.

## Review without reading code

For actual signed synthetic examples, run `node --import tsx scripts/review-stripe-receipts.ts`. It serves a disposable preview on loopback port 3003 with pending, incomplete and succeeded-event receipts, plus explicitly constructed Failed/unsupported display fixtures. The latter are not genuine provider failures; actual queue/storage failure handling is tested separately. Stop normally with Ctrl+C; the preview expires after 15 minutes and drops only its own database. It never seeds the normal workspace or connects a real Stripe account.

Open a receipt and check that amount/currency show a type, status may show Missing, actual values are absent, and the contract panel cannot claim a pass. A succeeded event remains Incomplete. Check that an unknown integration shows no receipts and that service/environment scope is explicitly unsupported.

Normal development data may be empty at `http://127.0.0.1:3000/dashboard/webhooks/stripe`; an empty view is expected, not an ingestion failure. The next separate milestone is explicit Stripe contract binding and supported validation. Performance benchmarking, live Stripe delivery, customer authentication and production readiness remain outside this slice.
