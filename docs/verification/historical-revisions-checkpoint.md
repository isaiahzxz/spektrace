# Historical revisions checkpoint — 2026-10-22

Verdict: implementation demonstrated with synthetic data; additive schema installed locally. This is not prospective-customer staging acceptance or verified runtime attribution.

## Previous milestone closed first

Read-only Express demo counters showed primary delivered 4; unavailable collector failed 2, delivered 0, pending 0. All 15 middleware tests passed again before historical changes. No scenario buttons or incident-producing demo verification were rerun for closure.

## New behavior verified

- Old string-amount contract selected for a delayed event while the active integer contract produces a different validation result.
- Inclusive start, exclusive end, separate rollback window, no historical-age cutoff.
- Missing coverage, same/different-revision overlap, 33-candidate overflow, unsupported precision and future occurrence remain unknown without active fallback.
- Exact workspace/service/environment/revision/hash/deployment linkage and import allowlist.
- Private import authorization distinct from ingestion; forged workspace/revision fields rejected; 4 KiB import cap.
- Idempotent immutable import with one audit; changed content conflicts. UPDATE/DELETE refused for imported intervals.
- Identical and concurrent incident retries preserve one receipt and immutable selection; mode changes conflict.
- Concurrent import and selection reached actual PostgreSQL lock waiters before release. Later imports did not rewrite prior selections.
- Legacy records remain untouched and are labeled not recorded. No AI runs, approvals or spec activation introduced.

## Automated results

- Full offline unit suite: 41 files, 380 tests passed in a disposable database.
- Historical integration suite: 12 tests passed; newly created `spektrace_test_history_*` databases were dropped afterward.
- Guard control: an isolated copy with unsafe active-revision fallback failed the intended missing-coverage assertion. Running application source was never mutated by this control.
- Typecheck and ESLint on changed TypeScript: passed.
- Production webpack build: passed; `/api/internal/contract-revision-intervals` included.

The initial restricted-shell full unit attempt encountered loopback/ACL/database access denials. It was not treated as a pass. The successful complete run used the disposable wrapper with required access. That wrapper matters because an existing nominal unit test resets its database; no shared development/test database was reset.

## Local installation observed

Only migration `20261022010000_historical_revision_intervals` was pending and was applied to local `spektrace`. Existing incidents, specs, credentials, audits, deployments, memberships, preparation and inference records compared unchanged before/after, excluding the two newly added nullable incident columns. No reset/reseed, new incident or historical binding was created. There are zero imported historical bindings. AI and payload proposals remain disabled.

SpekTrace dev app and worker were restarted with the regenerated client. Post-restart dashboard and authenticated incident read returned 200; older incident provenance read `legacy_not_recorded`, `runtimeVerified: false`. Worker startup log confirmed its incident processor/outbox dispatcher running. Separate Express demo returned 200 with the same delivery/failure counters. The separate server on 3100 was left alone.

## Founder review and remaining limits

Use the five outcome checks in `docs/historical-revisions.md`; the automated demonstration is available via `npm run verify:historical-revisions -- --unit --guard-control --build`. It is synthetic, with no external model request or company connection.

A binding is an operator assertion, not independently observed runtime. Shared pilot administration is not individual company authentication. The current UI has no new historical-selection panel; provenance is exposed through the private incident response. Imports stay disabled without the separate allowlist. There is no correction endpoint for erroneous immutable bindings in this slice. Do not claim sender verification, Sender+Revision grouping, or overall staging precision readiness yet. Those follow this milestone in the agreed sequence.
