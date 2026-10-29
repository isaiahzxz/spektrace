# Stripe test-mode receipt acceptance

This is a local development receiver for independently signed synthetic Stripe snapshot events. No Stripe account is connected. It does not receive live-mode events, Connect events, thin events, or arbitrary event types.

## What acceptance means

`POST /stripe/test/webhooks` verifies the original bytes with Stripe's SDK, checks the configured server-owned workspace/integration and ingestion credential, then commits a protected receipt and its outbox work item in one database transaction. Only a successful commit produces HTTP 202. An identical retained delivery produces HTTP 200 and the original receipt ID. A retained-evidence conflict produces 409. Storage failure produces 503; acceptance is not confirmed.

Accepted types: `payment_intent.payment_failed` and `payment_intent.succeeded`, test/account-scoped snapshot format only. A succeeded event is still only a stored event: Spek does not perform payment or business processing.

## Retention and identity limits

The receipt keeps the original `evt_...` ID, event type, event creation time, reported API version, configured integration and collector credential references, and bounded verification metadata. The configured endpoint secret establishes secret possession; it does not identify a customer, prove a Stripe account identity, or prove production behavior.

The protected body is a **value-free structural projection**, policy `stripe-payment-intent-shape@1`. For the fixed `amount`, `currency`, and `status` fields it retains only missing/present and JSON type. Every field value, nested key/value, customer identifier, arbitrary metadata, raw body, signature, and raw-body hash is discarded. Even the three selected field values are discarded, regardless of their contents. The receiver clears its raw body buffer after handling; this is not a guarantee of JavaScript process-memory erasure.

This is deliberately narrower than full sanitized payload retention. It cannot replay the original payload, perform amount/value validation, compare the complete Stripe schema, identify a partner/customer from body data, or detect a changed discarded value. Equal retained shapes and event metadata are indistinguishable. Changed retained metadata or selected-field type/presence produces 409. Extra fields are omitted, not classified as harmless by a schema check.

Retries are scoped by **workspace + stable configured integration ID + original Stripe event ID**. Signing-key rotation and collector-key rotation preserve that namespace and do not rewrite first-acceptance provenance. Integration disablement, current collector binding, credential revocation/expiry, signature freshness, and matched signing-key expiry are checked for duplicates too. Freshness/key expiry are rechecked after database lock waits.

## Asynchronous result

The existing outbox and BullMQ worker route a `validate-stripe-webhook` job. Until a Stripe contract is explicitly configured, it records **UNSUPPORTED / STRIPE_CONTRACT_NOT_CONFIGURED** with `bodyValuesRetained: false` and `businessProcessingConfirmed: false`. There is no passing schema verdict, mismatch incident, grouped drift, AI investigation, approval, notification, or automatic spec activation in this slice.

A missing published job is eligible for bounded requeue. A failed/completed job without persisted validation is marked failed for review, using the existing reconciliation policy.

## Local opt-in launcher

The additive migration is `20261023010000_stripe_test_receipts`. Generate the matching Prisma client after migration. Restart any already-running worker before enabling this receiver.

The launcher is disabled by default, refuses `NODE_ENV=production`, binds only to `127.0.0.1:3004`, and requires:

- `SPEKTRACE_STRIPE_TEST_ENABLED=true`
- `SPEKTRACE_STRIPE_TEST_CONFIG_FILE`: private JSON file outside the repository containing `verification` and `ingestionToken`.

`verification` is the existing strict test endpoint configuration: workspace UUID, integration UUID, `mode: test`, and one or two signing secrets with UUID, synthetic `whsec_...` material, and expiry. The integration must already exist in `stripe_webhook_integrations`, in that workspace, enabled and linked to the current ingestion credential. No automatic integration/credential issuance occurs. Treat both the ingestion token and signing secret as credentials; never paste them into a browser or report.

Run `npm run demo:stripe-test-webhook` only after explicitly provisioning the local configuration. Start the existing worker separately. Stop the receiver with Ctrl+C. No receiver, tunnel, real account, or new credentials were enabled by verification.

## Verification without reading code

Run `npm run verify:synthetic-webhook -- --stripe-receipts`. The wrapper creates a unique disposable database, applies migrations, exercises real local HTTP requests and a separate Redis queue namespace, and drops only its owned database. It does not reset `spektrace` or the shared `spektrace_test` database. AI/proposals remain off. Synthetic signing secrets and collector credentials are ephemeral test fixtures.

The checks should demonstrate:

1. Two concurrent deliveries return 202 and 200 with the same receipt ID, one receipt and one job.
2. Changing a selected field from string to integer returns 409; changing an omitted value cannot be detected.
3. Customer values and synthetic secrets are absent from retained receipt/job/evidence and responses.
4. Wrong workspace, disabled integration and revoked credential cannot write or acknowledge a duplicate.
5. A forced job-write failure returns 503 and leaves neither receipt nor job.
6. A signature that expires while waiting for a lock returns 400 and leaves no receipt/job.
7. The real queue processes the receipt to UNSUPPORTED, with the missing-contract reason, without creating incidents or AI runs.

These automated observations demonstrate local mechanics, not production readiness or real Stripe delivery. A founder can review the saved checkpoint report; there is no new dashboard page in this slice.
