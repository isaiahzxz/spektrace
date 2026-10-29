# Founder checkpoint: configured webhook revision — 2026-10-23

Verdict: implemented and demonstrated locally with synthetic data. No migration or staging deployment.

A signing key may now have an optional server-owned revisionBinding containing an existing revision id and SHA-256. A new event uses that exact revision within the collector's workspace, synthetic service and default environment, including when it is inactive. Without the option, active-at-acceptance behavior remains. No payload or header can choose the revision, and no historical revision is guessed from shape.

## The result you can inspect without reading code

The disposable preview contains an inactive Synthetic payments 1.0.0 integer contract and an active 2.0.0 number contract. A genuinely signed event with amount 100.5 is explicitly configured to use version 1. The receipt displays:

- Pinned revision: Synthetic payments 1.0.0.
- Revision selection: Server-configured revision · runtime unverified.
- Stored sanitized payload: amount 100.5.
- Validation: Mismatch, expected integer, received number.

The integration comparison submits that same decimal without a configured binding. It uses the active number contract and passes. This distinguishes actual selection behavior rather than checking a revision label alone. A passing body check still does not establish business correctness.

## Guard behavior observed

- Missing revision, wrong workspace/service/environment and mismatched hash: HTTP 422, no accepted receipt or validation outbox, no active fallback.
- Explicit retry: HTTP 200 and the original receipt. Changing the explicit target, removing it, or changing an existing default-mode event into explicit mode: HTTP 409. First acceptance records are retained.
- Spoofed revision headers do not choose a historical schema for an unbound key.
- Two mismatches for the same sender using different revisions form different groups.
- Caller mutation of a key object after app creation does not change the parsed server configuration. Malformed binding configuration fails startup with values withheld.
- Specifications remain at their original activation state. No 4xx incident or AI inference is created by the binding tests.

## Fresh verification

The pre-change baseline passed 47 integration tests across 7 files. The completed slice passed 402 unit tests across 48 files and 52 integrations across 8 files, including 5 new configured-revision tests. Four new deliberate source-copy regressions (removed workspace scope, removed hash, ignored configured target, removed retry comparison) were caught at the intended assertions. The existing ten controls also passed, for 14 total. Typecheck, changed-source ESLint and production webpack build passed. No assertion, timeout or protective boundary was weakened to make the run pass. The known Vite native configuration-loader warning was not suppressed. Next added its generated build-type include paths to the existing tsconfig, as it does for these isolated builds.

Core changes: shared revision provenance schema, optional binding in synthetic signing configuration, scoped acceptance lookup and retry checks, generic 422 response, validator/grouping pin recognition and the receipt selection label. The default Express 4xx monitoring package and separate demo installation were not changed. Signing wire protocol remains synthetic-hmac-sha256@1.

## Browser observations

Light desktop at 1440 × 1200 showed the actual receipt, selection label, decimal payload and integer-versus-number comparison together. At 390 × 844 the selection label wrapped within the existing receipt facts; document scroll width matched 390. The retained desktop screenshot is scrolled down slightly to include the entire comparison; it is a viewport capture, not a complete page image. Existing layout and focus styles were not changed. Dark theme and keyboard navigation were not re-tested in this label-only UI change. There is no new dashboard settings control for choosing a revision.

The synthetic preview and its database were stopped and removed. The normal development page remains empty: http://127.0.0.1:3000/dashboard/webhooks/groups . There are no surviving preview receipt links. To see it again, run `node --import tsx scripts/review-webhook-receipts.ts --configured-revision` and open the mismatch receipt on its temporary port 3003 page. Stop normally afterward. The preview's Failed row is a labeled display fixture; this checkpoint's selected integration suites separately cover worker failure behavior.

## Runtime and cleanup

Development webhook receipt, group and grouping-decision counts remain zero. No disposable databases remain. Local app on 3000 and Express demo on 3001 each returned HTTP 200. AI and payload proposals remain disabled. The idle local worker had zero active, waiting and delayed jobs; it was restarted to load the compatible reader. Replacement worker PID 18620 was confirmed running by process inventory and its startup log; its error log was empty. No private signing file, .env credential or real provider was configured or modified. The normal app and separate Express demo were not restarted.

## Scope and your review

You may configure a known contract; Spek still cannot establish which historical revision originally produced an arbitrary replayed payload. Server administrators are trusted to choose the binding. Rotate the public key id when changing key scope, material or revision policy. The server selection is not an original provider's signed revision assertion and does not prove deployment.

No arbitrary partner payload support, actual business replay/export, real provider integration, notifications, Slack, support tickets or production actions were added. This was a standard local threat/correctness review with executable guard controls, not an independent security audit. Review the screenshot for revision 1.0.0, the configured/runtime-unverified label, amount 100.5, and expected integer versus received number. Automated checks passed; human approval is not assumed. Cursor installation is not needed.

Reproduce the automated checkpoint with `npm run verify:synthetic-webhook -- --webhook-revision --webhook-signing --webhook-view --webhook-grouping --webhook-groups-view --webhook-corpus --unit --guard-control --build`. It creates and removes its own database rather than resetting shared development/test data.
