# Synthetic signing checkpoint — 2026-10-22

Verdict: demonstrated with synthetic fixtures only. A scoped HMAC signature verifies original request bytes before decoding, parsing or sanitizing. It proves possession of a configured synthetic signing key, not a real provider's identity or business completion.

Changes: separate signed Express factory and loopback launcher; scoped, expiring key configuration; timestamp/event/exact-target binding; private frozen proof tied to verified projection; existing sender-binding resolution under acceptance transaction locks; immutable nullable receipt verification snapshot; receipt detail disclosure; disposable tests, intentional bypass control, reproducible signing preview and instructions.

Fresh automated evidence:
- 397 unit tests in 46 files.
- 32 integration tests in 4 files: historical revisions, unsigned webhook pipeline, receipt views and signed boundary.
- Six unsafe-copy controls: privacy, atomicity, workspace view scope, protected payload display, signature comparison, historical fallback. Each intentional regression failed its intended assertion.
- Typecheck, changed-source ESLint, generated Prisma client, and production webpack build passed.

The signature cases cover concurrent duplicates, rotation with same mapped authority, first provenance retained, tampered bytes/event/timestamp/key, stale/future signatures and expired key, malformed/oversized input, compression/charset, duplicated headers, exact-target aliases, missing signature, wrong collector/workspace scope, unmapped/revoked binding, revoked credential, proof body/event substitution, omission protection, unsigned/signed conflicts and freshness after an observed database lock wait. Existing worker recovery and atomicity checks remain in the selected suite.

The first duplicate-header test failed because the low-level request omitted HTTP framing headers. The corrected fixture explicitly sends Host and Content-Length; application rejection was then observed. The endpoint did not require weakening. No test timeout or acceptance assertion was relaxed.

Visual review: real signed HTTP receipts in a disposable preview. Light and Dark desktop and Light 390px display the signature assurance note, sender reference and verification timestamp; the independent amount/string mismatch remains visible. Horizontal document width equaled the viewport at 1440 and 390. No new focusable controls were added. Production login, external provider and keyboard regression are not claimed by this review.

Local activation: only 20261022050000_synthetic_webhook_signing applied, no reset, existing records unchanged excluding new null column, zero development receipts. No new development specs/credentials/fixtures. Generated client loaded by restarting the verified app and worker. Other demo servers left alone. Temporary preview and owned database removed after review. AI/proposals remain off, signing launcher remains opt-in.

Founder review without code: open the saved signed-receipt screenshots. Read **Synthetic signing key verified** and its caveat; confirm the expected integer/received string comparison is a separate result. To reproduce rejection/deduplication, use the disposable command in docs/synthetic-webhook-signing.md; request counts and failed/skipped checks rather than relying on a success label. A live provider pilot still requires that provider's published signing protocol, key lifecycle, identity mapping, and data-protection review.
