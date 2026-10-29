# Founder checkpoint: signed webhook mismatch grouping

Verdict: demonstrated locally with synthetic data only.

Two independently signed webhook receipts, with amount values "100" and "200", now share a durable group because their sender, pinned contract revision and structural mismatch agree. Receipt details show group id, count, UTC received-time bucket and an explicit limit: related mismatches do not establish a shared root cause or business failure.

Only the bounded synthetic amount type/required-field rules are supported. Different senders, revisions, observed types, required-field rules, workspaces or 15-minute receipt-time windows remain separate. Passing, incomplete, unsigned and unsupported evidence receive an explicit exclusion decision. Earlier completed receipts are not backfilled or reclassified.

The body validation result and one grouping decision commit together. Failure to write the decision rolls back validation and any new group, leaving existing worker retries able to recover. Retries and concurrent validation do not duplicate membership or counts. Database constraints enforce workspace links and group/exclusion consistency. Group dimensions and decisions reject edits and deletion. No incident, AI inference, correction, replay, alert or business execution is added.

## Evidence from this checkpoint

- 400 unit tests in 47 files passed.
- 42 integration tests in 5 files passed, including 10 new grouping tests.
- Seven deliberate unsafe-source controls were caught, including a query that intentionally omitted the sender dimension.
- Fresh typecheck, changed-source ESLint, generated Prisma client and production webpack build passed.
- Deletion regression initially demonstrated that UPDATE-only triggers allowed deleting a decision. The migration was corrected before local installation and direct decision/empty-group deletion was then refused. No assertions/timeouts were weakened.
- A failed validation job is shown as validation did not complete rather than awaiting validation.
- Browser review used actual signed HTTP receipts in a disposable workspace: both mismatches showed the same group and count 2; Passed showed no conclusive mismatch. Light/Dark desktop and Light phone layouts were checked. Document width matched 1440px and 390px viewports. No new interactive control or color system was introduced.

## How to review without reading code

1. Open the saved desktop screenshot and find **Drift grouping**.
2. Confirm **2 receipts with the same sender, structural mismatch and pinned revision** and the 15-minute UTC bucket.
3. Read the no-shared-root-cause/business-failure caveat. Separately inspect the schema result: integer expected, string received.
4. For a repeatable demonstration, use the disposable preview described in docs/webhook-drift-grouping.md. The two mismatch receipts should have the same group id. Passed and Incomplete should be ungrouped.

These checks establish synthetic mechanics, not customer-data safety or provider authentication. Original-provider identity, deployment identity and business processing are not proven by grouping.

## Local state and limits

Only additive migration 20261022060000_webhook_drift_grouping was installed on local spektrace. Guarded comparisons showed existing records unchanged, no reset and no new development receipts or credentials. The app/worker were restarted; the separate Express demo was preserved. AI and payload proposals remain disabled. Disposable preview and test databases are removed after review.

This milestone exposes grouping on receipt details. A dedicated grouped feed and group drill-down are later work. No historical sweep, generic schema fingerprint engine, provider connector, support tickets, Slack or production deployment is included. Cursor is not required to review this checkpoint.
