# Sender Identity checkpoint — 2026-10-22

Verdict: synthetic attribution mechanics demonstrated; core installed locally. No customer sender verification or production readiness claim.

## What changed

Canonical workspace sender registry, exact collector/service/environment/principal bindings, private registration/revocation routes, and immutable incident attribution snapshots. Express package 0.2.0 adds an application-authentication callback and keeps reported client headers separate. Contract selection, validation, grouping, approval/severity and agent evidence export retain their existing behavior.

## Fresh checks

- Baseline before changes: 380 unit tests and 12 historical integration tests passed in a fresh disposable database.
- Final unit suite: 42 files, 386 tests passed.
- Integration: 4 files, 37 tests passed (14 sender, 12 historical, 9 credential, 2 application adapter).
- Exact scopes, spoofed matching header, internal untrusted submission, UUID normalization, tombstones, revoked/rotated credentials, duplicate and changed concurrent claims, immutable snapshots, late mappings and actual PostgreSQL lock waiters were exercised.
- Offline tarball installation: `@spektrace/express-monitoring@0.2.0` loaded by package name in a separate disposable consumer. Real local HTTP preserved HTTP 400/response text and delivered both authentication-context and header-only events with distinct attribution. Original authentication secret absent from stored incidents.
- Guard controls: isolated copies with unsafe historical fallback and reported-header upgrade failed the intended assertions. Application source never altered by controls.
- Typecheck, changed-source ESLint, Prisma schema validation and production webpack build passed. Both sender registration/revocation routes are included.

An initial HTTP test incorrectly assumed concurrent delivery completion order; per-event flush removed that assumption without changing the expected identity outcome. The initial negative-control harness searched for the matcher function name instead of Vitest's assertion wording; its diagnostic marker was corrected and the actual expected failure verified. The revocation test was also ordered around observed lock waiters to avoid assuming scheduling. No product security guard was weakened.

All DB fixtures were in newly created `spektrace_test_history_*` databases and dropped afterward. No shared database reset, live model request, or company data used. Full nominal unit execution stays in this wrapper because an existing unit harness resets its target DB.

## Local installation

Only additive migration `20261022020000_sender_identity` was pending and applied to localhost `spektrace`. Existing incidents, specs, credentials, audits, deployment/historical records and investigations compared unchanged before/after, excluding the newly added nullable incident fields. No new incident, sender registration or binding was created. Zero sender bindings exist in the local workspace. AI and payload proposals remain disabled.

App/worker restarted with the new client. Live smoke: dashboard 200; authenticated incident GET 200 with `legacy_not_recorded` and original authentication verified false; invalid admin binding body 400; ingestion key on administrative import 401. Worker startup confirmed processor/outbox dispatcher running. Express demo 3001 still returned 200 and unchanged counters: primary delivered 4; unavailable delivered 0, failed 2. Separate server on 3100 untouched. Restart guards initially stopped before any process changes until the scoped compiler/hidden console child processes were identified.

## Founder review without code

The key observable result is a contrast: registered authentication context → **Integration attested**; the same UUID supplied only in X-Client-ID → **Reported**, no canonical sender. Wrong scope → **Unknown**. Revocation blocks new attribution but preserves older snapshots. Changed logical-event claims conflict instead of making another incident.

Read these as mechanical results only. A human still needs to review a real application's authentication source and callback. SpekTrace records integration attestation, not independently verified caller identity. UUID-shaped secrets remain secrets; only configured nonsecret aliases belong in mappings. Shared pilot admin auth, immutable records without correction UI, and unknown legacy identity remain explicit limits.

The existing demo is still installed with 0.1.0 and has no authenticated identity source. It was not relabeled or silently upgraded. New callback behavior was verified through the independently installed 0.2.0 package in the disposable HTTP test. Next: Triage Grouping; no sender-based regrouping is included here. No tickets, Slack, production actions or AI activation.
