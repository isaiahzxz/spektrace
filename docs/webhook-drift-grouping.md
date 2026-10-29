# Signed webhook drift grouping

This checkpoint groups newly validated **synthetic signature-verified** webhook mismatches. It does not create 4xx incidents, investigate with AI, change approval state, execute business work, replay payloads or send alerts. Real provider identity and runtime revision remain unverified.

## What groups together

Version 1 uses workspace, service, environment, POST operation, canonical sender id from acceptance-time verified provenance, pinned specification id and hash, supported structural drift fingerprint, and a 15-minute UTC bucket based on the server's receivedAt. The lower time bound is inclusive and the upper bound exclusive. Validation can occur later without changing the bucket.

Two different signing keys or principal bindings mapped to the same canonical sender can share a group. Different verified senders cannot. Later credential/binding revocation does not erase an already accepted receipt's verification basis. Unknown or unsigned senders are never pooled together as a shared Unknown sender.

The bounded fingerprint supports only inline `/amount` type mismatches and missing required amount. It includes rule/path, expected type and observed type (or missing). Different payload values with the same structural mismatch can merge. Messages, payload values, secrets and PII are not fingerprint inputs. Unsupported, malformed, partially omitted or excessive findings exclude the whole receipt from grouping, rather than using a fallback identity.

## Durable decisions

The validation worker commits its body result and one immutable WebhookGroupingDecision together. A GROUPED decision links one WebhookDriftGroup; other closed reasons leave groupId empty. Database checks enforce that relationship, workspace-scoped foreign keys prevent cross-workspace links, and unique constraints plus receipt/group locks prevent duplicate memberships under retry or concurrent validation. Counts are read from decisions, not incremented counters.

If a decision write fails, validation and any new group roll back, leaving the accepted receipt NOT_RUN so existing bounded worker retries can recover. Acceptance itself remains durable. Worker exhaustion still shows Failed/operator review. There is no grouping-triggered AI/outbox or additional receipt ingestion route.

Group dimensions and decisions refuse both UPDATE and DELETE. The app adds no retention/deletion workflow for them in this checkpoint; production retention policy and privileged database maintenance remain separate work. Existing receipt acceptance metadata is unchanged.

Old completed receipts are not backfilled or regrouped on reads. They say **Not evaluated by this grouping version**. Pending receipts say evaluation awaits validation; terminal unvalidated jobs say validation did not complete. Newly checked but excluded receipts show a stored reason. Body-check success never becomes a drift failure.

## Founder review without reading code

1. Open the saved receipt screenshot. Under **Drift grouping**, confirm it says **2 receipts with the same sender, structural mismatch and pinned revision**.
2. Read the UTC bucket and the note: **Related stored mismatches do not establish a shared root cause or business failure.**
3. Notice the independent request-body result: expected integer, received string. Signature proof, grouping, schema validation and business processing are separate claims.
4. In the disposable preview, open the two mismatch receipts: their group id and count should agree. Open Passed: it should be ungrouped with no conclusive mismatch. Incomplete should also stay ungrouped.

Reproduce with `node --import tsx scripts/review-webhook-receipts.ts --grouping`. This creates its own disposable database, sends genuinely signed synthetic HTTP requests, and serves the review dashboard on loopback port 3003 for up to 15 minutes. The two values `"100"` and `"200"` deliberately share the same drift shape. The Failed row is a labeled display fixture; real worker failures are tested separately. Stop with Ctrl+C or the existing preview control file; owned preview data is removed.

Automated verification:
`npm run verify:synthetic-webhook -- --webhook-signing --webhook-view --webhook-grouping --unit --guard-control --build`

The wrapper creates and removes a new database; it does not wipe the shared test or development database. Its deliberate missing-sender source copy must fail sender separation, establishing that the test detects that regression. Report executed counts, failed/skipped checks and limits rather than treating a success banner as proof of customer readiness.

## Installation and remaining scope

Migration: `20261022060000_webhook_drift_grouping`. The guarded local installer accepts `--grouping`, permits only this pending migration on local spektrace, compares existing records unchanged and adds no demo fixtures. Regenerate Prisma and restart the app/worker when installing. AI and proposals remain disabled.

This adds a receipt-detail association, count, window and exclusion reason. It does not yet add a dedicated grouped feed, group drill-down, historical sweep, generic schema fingerprinting or external partner integration. Default service scope remains `synthetic-webhook-payments/default` and `/payments`.
