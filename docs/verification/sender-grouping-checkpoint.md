# Triage Grouping checkpoint — 2026-10-22

Verdict: v2 grouping mechanics demonstrated with synthetic data and installed locally. This is not exhaustive replay-corpus acceptance or production readiness.

## Implemented behavior

New groups use canonical integration-attested sender and proven pinned revision, plus existing scope/method/operation/finding/received-window dimensions. Unknown senders or uncertain revisions are incident-specific. Strict sender snapshot/binding/registry checks prevent claim/header-based correlation. Revision proof checks typed v1 evidence, scoped id/hash, consistent outcome/findings, validator and matched body-check scope. Revocation preserves past attestations.

Existing memberships return before group creation, including legacy v1 memberships; no automatic reparenting or regrouping. New group uniqueness includes version and sender key. Membership, version increment and preparation scheduling stay atomic, with whole-transaction uniqueness retries.

## Fresh verification

- Final full unit refresh: 43 files, 389 tests passed in a newly created disposable database; 12 historical checks passed in the same wrapper afterward.
- Current combined integration run: 5 files, 48 tests passed (11 grouping, 14 sender, 12 historical, 9 credential, 2 adapter).
- Existing grouping/preparation regression: 8 tests passed in a separate child phase, using that new DB and its own Redis namespace. Tests that intend equivalent sender grouping now use actual scoped collector bindings and valid spec SHA-256 fixtures; assertions were retained. Passing-body and unresolved-operation fixtures also use the same trusted sender to avoid accidental isolation through unrelated identity differences.
- Four isolated source-copy controls caught unsafe historical fallback, spoofed header upgrade, omitted sender lookup dimension and omitted evidence validity. The expected assertions failed; real application source was unchanged by the controls.
- Typecheck, changed-file ESLint, Prisma schema validation and production webpack build passed.
- The installed 0.2.0 Express package and prior HTTP sender checks remained in the combined regression path. No live model requests occurred.

New grouping cases cover equivalent known senders, distinct senders, historical revisions with identical findings, spoofed/unknown attribution, aliases across collectors, revocation, exact windows, method/operation/finding distinctions, uncertain revisions, transplanted provenance, existing legacy memberships without orphan groups, concurrent duplicate assignment, isolated protected manifests and workspace/key constraints.

Security review identified lenient stored evidence parsing during implementation. Grouping now rejects minimal matching id/hash records, empty mismatch findings, contradictory outcomes, mismatched method scope and malformed optional finding fields. Each variant was tested twice and remained isolated. A source-copy control removing the validity gate caught the regression.

## Local installation

Only `20261022030000_sender_revision_grouping` was pending and applied to localhost `spektrace`. Existing records compared unchanged except new legacy group columns. The three existing groups now have grouping version 1 and legacy sender keys; memberships, preparation/inference records, incident validation/review state, credentials, sender registrations and outbox records were not rewritten. No reset, backfill, new incident, fabricated identity or regroup was performed.

App and worker restarted with the regenerated client. Read-only smoke: dashboard 200, authenticated incident GET 200, legacy sender label preserved, worker startup confirmed. Database still has exactly three v1 groups. Express demo 3001 returned 200 with unchanged counters (primary delivered 4; unavailable delivered 0, failed 2). Separate server 3100 untouched. AI and payload proposals remain disabled.

## Founder review without code

Expected contrast: the same sender/revision/finding/window shares a group; change sender or revision and it separates. A client header cannot put an incident into that sender's group. Unknown identities do not become one shared client. Duplicates count once; a legacy incident stays in its old group. Prepared evidence contains only that group's incident references and no exported sender identity.

These are automated mechanical checks. Human review of real integration identity/deployment assertions and a prospective customer's edge corpus is still outstanding. The 15-minute window, conservative unknown singletons, lack of cross-window correlation, legacy group retention and unmeasured production rollout/index timing are explicit limits. There is no new grouping UI, ticket/Slack behavior, production action, automatic correction or AI activation. Next is Validation & Evidence.
