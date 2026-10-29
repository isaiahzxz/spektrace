# Synthetic webhook acceptance

This opt-in loopback Express 5 endpoint is a fixture-only store-and-validate slice. It authenticates a workspace ingestion credential, sanitizes locally, commits a receipt plus validation outbox event, and then acknowledges storage. It does not process payments or prove original provider authentication. It is separate from the passive 4xx adapter and adds no Next.js application route.

## Contract

`POST http://127.0.0.1:3002/synthetic/webhooks/payments`

- One `Authorization: Bearer <ingestion credential>` header, server-side only. This is collector authentication, not a provider signature.
- One `X-Spek-Event-Id: <UUID>` header. Retries reuse it. Workspace comes from the credential, never the request body.
- `Content-Type: application/json`, maximum 4096 bytes, no compressed bodies.
- Payload permits only `amount` (optional bounded number, numeric fixture string, `invalid`, or null) and optional string fields `email`, `name`, `password`, `cardNumber` (max 256 characters each).
- Privacy fields are omitted before persistence. Unknown keys and unsafe retained amounts are rejected; arbitrary company/payment payloads are unsupported. This narrow fixture allowlist is not general PII detection.
- Service `synthetic-webhook-payments`, environment `default`, operation `POST /payments` are server-owned constants. No sender is inferred from headers and no user identifier hashing is performed in this slice.

New acceptance returns **202** with a receipt id after transaction commit. An identical protected projection returns **200** and the same id. Changed protected content under the same event id returns **409**. Invalid/revoked/expired credentials return **401**; invalid or oversized input returns **400/413**, unsupported content encoding/type **415**. Storage errors return **503**, acceptance unconfirmed. A commit whose HTTP response is lost can still have succeeded: retry the same id to find its receipt.

Dedupe namespace is workspace + ingestion credential + event UUID. Credential rotation creates a different namespace. Equality covers the sanitized projection and omission policy only: changing omitted PII is not detected. No omitted originals or hashes of them are retained.

## Validation

`webhook_receipts` keeps the sanitized projection, policy/omission names and acceptance-time specification pin. `outbox_events` links the receipt using a workspace-scoped foreign key. Both writes share one transaction. Receipt acceptance fields are immutable.

The existing worker dispatches `validate-webhook` jobs through BullMQ; the job validates only the pinned OpenAPI JSON body schema. It never switches to a newer active revision. Missing pin, unsupported schema or omitted fields produce **UNSUPPORTED**. Complete fixtures produce **PASSED** or **MISMATCH**. The same receipt is processed once, including concurrent deliveries. Acceptance and a passing schema check do not prove business correctness.

No incident, group, AI inference, payload proposal, notification or business action is created. There is no dashboard receipt view in this slice. Queue publication failures leave the durable outbox pending. Existing queue retries/claim recovery apply. A bounded reconciliation checks up to 20 published, unvalidated receipt jobs older than 30 seconds: a confirmed missing Redis job is requeued; a failed/completed job without validated receipt is marked FAILED with `WEBHOOK_JOB_TERMINAL_WITHOUT_VALIDATION` for operator review. Redis lookup errors do not count as missing jobs, and conditional updates preserve newer claims/publications. Full production dead-letter tooling and disaster recovery remain outside this slice.

## Founder review without reading code

Run `npm run verify:synthetic-webhook`. It creates a fresh disposable database and uses a unique Redis namespace. It does not reset the development or shared test database. Review the test output for:

1. Same event submitted concurrently: one 202, one 200, one receipt and one outbox job. A different amount under that id: 409.
2. Fixture email/name/password omitted from storage; validation says incomplete rather than falsely passed.
3. Forced outbox write failure: 503 and neither receipt nor job persists. Retry after recovery: 202.
4. HTTP acceptance before worker startup, then intentional removal of the published Redis job: reconciliation requeues it and a new worker process completes MISMATCH against its acceptance pin.
5. Passing amount 100, missing amount and null amount: PASSED, MISMATCH, MISMATCH respectively, without failure incidents or AI.
6. A forced validation storage error exhausts the test job: the receipt remains unvalidated and the outbox records a fixed operator-review failure, with no endless retry.

These are automated synthetic checks, not a live provider/production evaluation. Ask for the matching result counts and any skipped checks; do not infer success merely from the existence of this document.

## Optional manual local launch

Apply the migration through the normal reviewed database deployment process, regenerate Prisma, and restart the worker before launch. Do not point the new worker at an unmigrated database. Create an active synthetic fixture OpenAPI revision for `synthetic-webhook-payments/default` with `POST /payments`, required integer amount, if you want a conclusive body check. With no revision, acceptance still works but validation is unsupported. No script silently creates a development spec or credential.

Set `SPEKTRACE_SYNTHETIC_WEBHOOK_ENABLED=true` only in the launcher environment, then run `npm run demo:synthetic-webhook`. Use a local request client with a server-side ingestion credential. No token belongs in browser UI, screenshots, shared cURL commands or support messages. Run `npm run worker` separately. Stop the launcher and worker when finished. AI and payload proposals should remain disabled.
