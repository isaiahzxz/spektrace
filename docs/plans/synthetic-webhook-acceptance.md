# Synthetic webhook acceptance — 2026-10-22

Status: implemented, synthetic verification complete, additive local migration installed. Worker restarted. Opt-in endpoint launcher is not running by default.

Outcome: a loopback-only Express endpoint acknowledges a bounded synthetic payment webhook only after its sanitized receipt and validation outbox event commit together. A later worker validates the pinned body schema. No business processing, incident fabrication, AI, replay, alerts or customer provider integration.

Receipt identity is workspace + authenticated ingestion credential + UUID event id. Duplicate equality concerns the sanitized projection and protection metadata only; omitted originals are neither retained nor hashed. Credential rotation starts a new dedupe namespace. Active-at-acceptance revision is a pin, not verified deployment provenance.

Implementation: separate WebhookReceipt model and migration; synthetic field allowlist; transactional acceptance service; Express factory and opt-in local launcher; typed outbox/worker route; receipt-only body validation. Existing 4xx contracts remain unchanged.

Acceptance checks: HTTP auth and parser limits, PII omission, immutable pin, concurrent duplicate and conflict, atomic rollback on outbox failure, honest 503 on unavailable storage, close/reopen processor after acceptance, idempotent validation, workspace isolation, no incident/group/AI writes. Verification uses a newly created disposable database and unique queue namespace, never resets existing databases. Fresh typecheck, lint, relevant regressions and production build before handoff.

Security review completed before implementation: collector/provider distinction; restricted retained amount; omission policy version; credential lock and dedupe lock; fixed parser errors; receipt-specific routing and workspace foreign keys.

Completed checks: 391 unit tests, 66 integration tests (10 new webhook checks plus 56 historical/sender/grouping/credential/adapter regressions), six isolated unsafe-copy guard controls, typecheck, changed-source lint, Prisma validation and production webpack build. A fresh final unit/webhook run after the migration timeout settings passed 391 units and 22 selected integrations. No real provider/model calls.

Review found a missing-published-job recovery gap. Bounded receipt reconciliation now requeues confirmed missing jobs and records terminal unvalidated jobs as operator-review failures. Real BullMQ tests removed a published job and restarted a worker process; another forced a validation storage failure and confirmed terminal recording.

Local installation applied only 20261022040000_synthetic_webhook_receipts. Existing table contents compared unchanged (excluding the new null outbox foreign-key column); no fixtures, incidents, specs or credentials added. Receipt count remained zero. Worker startup confirmed; existing ports 3000 and 3001 returned 200. AI and proposals remain disabled. Manual review still requires synthetic requests through the opt-in launcher; no dashboard receipt UI or original-provider signature validation is claimed.
