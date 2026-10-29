# Founder checkpoint: webhook group feed — 2026-10-23

Verdict: implemented and verified locally with synthetic data. No migration or production rollout.

Under Accepted webhooks, Receipts and Drift groups now select two read-only views. The group feed shows configured sender, endpoint, pinned revision, receipt count and received-time bucket. Open group shows the metadata plus up to 20 member receipts per page. View receipt opens the existing protected evidence page; Open drift group returns to the associated group.

Group pages retain service and environment filters. Group-list page is preserved through detail/back/member-page links. Member page uses its own parameter. Returning through a receipt's group link retains service/environment and starts at group page 1. Groups refresh manually, without changing grouping or validation state.

The feed exports metadata only. Payloads, validation blobs, auth headers and collector credentials are not selected into its read models. Empty scope, out-of-range page, unavailable store, invalid filter and unknown/out-of-scope group have separate states. Existing dev-only page restriction is preserved; this is not production tenant authentication.

## Automated evidence

- 402 unit tests across 48 files passed.
- 46 selected integration tests across 6 files passed, including four new group-view tests for workspace isolation, filtering/pagination, bounded metadata export and invalid ids/member pages.
- Ten deliberate unsafe-source controls were caught: the prior seven plus removed list workspace scope, removed detail workspace scope, and a payload-select/spread regression. Each failed its intended assertion; actual sources were unchanged.
- Fresh typecheck, changed-source ESLint and production webpack build passed, including both new group routes.
- The first stored-record fixture missed the required credential id. That fixture was corrected; no assertion or timeout was weakened. The new tests use explicit DB read fixtures; the separate signed pipeline suite and disposable visual preview exercise actual signing/ingestion.

## Founder review without code

1. Open Accepted webhooks, then Drift groups.
2. Find the synthetic POST /payments group: count 2, Synthetic review sender, Synthetic payments 1.0.0 and one received-time bucket.
3. Open group. Both member receipts should be listed; open one to see amount string vs expected integer in its protected evidence.
4. Use Open drift group to return. Filtering to default/synthetic-webhook-payments should retain the same scoped group; another environment should show no groups in that scope.
5. Read the caveat: grouping does not establish a shared root cause, real-provider identity or business failure.

Reproduce using `node --import tsx scripts/review-webhook-receipts.ts --grouping`. It creates a disposable workspace/database and signed fixtures on loopback port 3003. Its Failed receipt is an explicit display fixture. Stop the preview through Ctrl+C or its existing control file; the owned database is dropped. Development records are not seeded for screenshots.

Repeat automated checks with `npm run verify:synthetic-webhook -- --webhook-signing --webhook-view --webhook-grouping --webhook-groups-view --unit --guard-control --build`. This creates a new disposable database, never resets shared test or development data, and makes no model calls.

## Scope limits

No grouping writer changes, historical backfill, new authentication, AI invocation, corrected payload, replay/export, Slack, support tickets, provider integration, or business action. The narrow synthetic amount type/required grouping policy remains unchanged. Group data is not evidence of original provider identity or deployment correctness. Cursor installation is not needed for this checkpoint.

## Browser observations and cleanup

Observed with actual signed synthetic receipts in a disposable preview: Receipts → Drift groups → Open group → View receipt → Open drift group. Two members remained after manual refresh. Applying default / synthetic-webhook-payments retained scope through the group link. Light desktop and Dark desktop were reviewed at 1440 × 900; Light phone at 390 × 844. The phone members stack, and document width equals viewport width (390); desktop width was 1440. The global section strip scrolls horizontally on phone. Real Tab produced a visible 2px focus outline on View receipt. Screenshots are viewport captures, so lower content can be below the fold; they are not full-page captures.

The preview was stopped normally and its owned database dropped. A read-only cleanup check found zero remaining disposable databases and zero development webhook receipts, groups or decisions. Existing app (3000) and Express demo (3001) each returned HTTP 200. AI and proposals remain disabled. No app/worker restart was needed. Light was restored and the viewport override removed. The normal group page is empty because no synthetic records were added to development for this review.

Browser review did not exercise 21-item pagination or force an unavailable database; those page boundaries and query isolation are covered by automated checks. No real provider or production identity was verified.
