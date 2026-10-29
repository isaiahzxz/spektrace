# Historical contract selection

This is milestone 1 of Historical Revisions → Sender Identity → Triage Grouping → Validation & Evidence.
It adds contract selection for delayed/replayed events. It does not establish sender identity or production readiness.

## What selects a contract

Normal submissions keep `revisionSelectionMode: "active_at_ingestion"` (also the default when omitted). They pin today's active revision and make no historical-runtime claim.

Replay submissions explicitly set `revisionSelectionMode: "historical"`. The event's reported `occurredAt` must be UTC with exactly three fractional digits, for example `2025-01-01T00:00:00.000Z`. Future times, unsupported time precision, gaps, multiple matching bindings (even the same revision), or more than 32 candidates produce unknown/UNSUPPORTED. There is no fallback to today's active revision and no payload-shape guessing. No seven-day history cutoff applies.

A historical match uses an immutable operator-asserted interval: inclusive `validFrom`, exclusive `validUntil`. Both endpoints are required and finite. A rollback is a new interval referencing an older revision; it does not activate that revision. Overlapping windows remain ambiguous. There is no edit/delete endpoint; incorrect windows cannot be repaired in this slice. Resolve source data with the operator before importing it.

## Trust and import setup

`POST /api/internal/contract-revision-intervals` uses the existing private pilot **admin** bearer, not an ingestion credential. Workspace comes from that authentication. The body is strict and capped at 4 KiB. Configure `SPEKTRACE_HISTORICAL_BINDING_ALLOWLIST` separately from deployment-event imports:

```json
[{"integrationKey":"synthetic-ci","apiKey":"payments-api","environment":"default"}]
```

Body fields: `integrationKey`, `sourceIntervalId`, `sourceDeploymentId`, `apiKey`, `environment`, `apiSpecId`, `sourceSha256`, `validFrom`, `validUntil`. The revision must already exist in this exact workspace/service/environment with the supplied SHA-256. A deployment record must already exist with the exact workspace/integration/deployment/service/environment/revision association. Import does not fetch URLs or repositories.

**The trusted source is asserting the interval; SpekTrace does not independently verify runtime.** A successful deployment event or matching commit alone does not create a binding. The interval assertion remains the authority even if advisory deployment events differ; SpekTrace does not reconcile rollouts in this milestone. Operators must not import uncertain or incomplete intervals as authoritative. Every selection stores `runtimeVerified: false`, the reported-occurrence time basis, revision hash, binding/import identifiers, source identity, import time, authority and resolver version. `importedBy: pilot_internal_admin` identifies a shared administrative mechanism, not an individually authenticated person. Production operator identity/authentication remains separate work.

`apiKey` here is a service identifier, not a customer's secret or a verified sender. Never import raw customer API credentials as identifiers.

Identical imports return 200 and the existing binding; new imports return 201 and one registration audit. Changed content with the same `(workspace, integrationKey, sourceIntervalId)` returns 409. Scope/hash/link errors return 400; unallowlisted imports return 403. Bindings are immutable in the database.

## Stability and inspection

Incident idempotency remains `(workspace, source, sourceEventId)`. Changing selection mode on the same logical event conflicts; it cannot create another incident. Identical retries return the original selection, even after late imports or overlaps. Import and selection serialize by workspace/service/environment. The selection is committed atomically with the incident and protected against later rewriting; no historical backfill mutates existing incidents. Old rows retain null provenance and are shown by the administrative incident response as `legacy_not_recorded`.

The existing administrative incident GET response exposes `revisionSelectionMode` and `revisionSelection`. Monitoring credentials still receive a receipt only and cannot read incidents/import bindings. No new dashboard surface is added. The worker validates the pinned revision, without choosing a newer one. Existing AI/export boundaries, approval/severity and grouping dimensions stay unchanged.

## Founder review without reading code

Ask for the synthetic historical-revision report and check these outcomes:

1. The same string amount passes the old string contract, while the current integer contract reports a mismatch. Both HTTP responses remain 400; body validation does not explain that HTTP failure.
2. An event exactly at the interval start matches; exactly at its end does not. A separate rollback window can select the old revision again.
3. A gap, overlap, excessive candidates or future occurrence shows unknown rather than today's revision.
4. Retrying the same event after another import keeps its original incident and selection. Changing mode conflicts. No approval or active specification is changed.
5. The report says **imported historical binding; runtime unverified**. It must not claim a verified sender or guaranteed production version.

Automated verification covers those mechanics; human review must decide whether a real company's interval assertions are accurate and suitable. No real company is connected by these checks.

## Safe verification and local installation

`npm run verify:historical-revisions -- --unit --guard-control --build` creates a uniquely named disposable `spektrace_test_history_*` database, applies migrations there, runs offline unit checks plus historical integration tests, checks an unsafe fallback against an isolated source copy, builds the application, and drops only that new database. It never resets existing databases. The full unit suite contains a reset-based harness test, so use this isolated wrapper instead of running it against a shared database.

Before a local app restart, apply additive migration `20261022010000_historical_revision_intervals` to the intended local database with the existing migration procedure and regenerate the client. Do not reset/reseed. Keep AI/proposal flags disabled. Historical imports stay disabled until an allowlist is configured; do not create demo bindings to manufacture historical certainty for existing incidents.

For this local installation, `npx tsx scripts/activate-local-historical-revisions.ts` preflights the exact localhost `spektrace` target, refuses unexpected pending migrations or enabled AI/proposals, applies only this migration, and compares existing incident/spec/audit/credential/deployment/investigation records before and after. It prints safe installation metadata only. Restart the app and worker afterward. The script does not configure an allowlist or import historical bindings.

This slice includes no tickets, Slack, model calls, payload replay into a business API, automatic deployment/spec activation, sender grouping, or new monitoring integration.
