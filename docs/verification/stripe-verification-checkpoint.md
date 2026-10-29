# Founder checkpoint: Stripe verification boundary — 2026-10-23

Verdict: the first local Stripe-specific verification slice is implemented and demonstrated with synthetic events. It is not a connected Stripe integration or a staging acceptance endpoint.

## What changed

Added a verification library using the official Stripe SDK pinned to 23.0.1, a bounded synthetic runner, tests and documentation. The package was installed with lifecycle scripts disabled and has no additional runtime dependencies. Existing package and lockfile changes were preserved. No secret, API key, Stripe account, endpoint registration or tunnel was configured.

The verifier accepts original body bytes and original header pairs, verifies a configured endpoint secret, checks freshness and expiry, validates a minimal snapshot event envelope, and returns an in-memory capability for bounded metadata. It does not store or return the payment object. Its configuration supplies workspace/integration scope; untrusted headers and JSON cannot choose that scope.

Support is deliberately limited to test-mode, account-scoped payment_intent.payment_failed and payment_intent.succeeded snapshot-shaped events. Live, Connect/organization, thin/v2 and other event types are rejected. This is not full PaymentIntent schema validation, mapping to an OpenAPI revision, or customer identity verification. The API version is reported metadata only. Signature verification proves possession of the configured secret; no actual delivery from Stripe was observed.

## Review without reading code

1. Read the expected-versus-observed list below. A valid locally signed snapshot verifies. A changed byte, wrong secret, stale/future signature, duplicate header and malformed envelope do not.
2. Read the safe result sample in the companion JSON file. It contains only event/scope/time metadata. Its workspace, integration and secret ids are generated fixture identifiers, not installed database records.
3. Confirm deliveryAcknowledged is false, payloadStored is false, databaseTouched is false, providerRequests is 0, and humanReviewComplete is false.
4. The normal dashboard has no new Stripe page or receipt. That is expected: this step exposes no HTTP acceptance route. Do not register a Stripe destination or send real events to the existing synthetic endpoint.

To reproduce: run `npm run verify:stripe-boundary` in the SpekTrace repository. No credentials or database are needed. The runner deletes its previous result before starting, runs tests and intentional unsafe-source controls, and writes a new report only after assertions pass. It was also exercised successfully from the Windows Temp directory using the repository's explicit Node/tsx entry paths.

## Expected versus observed

- Valid locally signed test snapshot: expected VERIFIED:payment_intent.payment_failed; observed VERIFIED:payment_intent.payment_failed.

- Byte changed after signing: expected SIGNATURE_INVALID; observed SIGNATURE_INVALID.

- Added byte-order mark: expected INVALID_ENVELOPE; observed INVALID_ENVELOPE.

- Wrong endpoint secret: expected SIGNATURE_INVALID; observed SIGNATURE_INVALID.

- Stale signature: expected TIMESTAMP_OUT_OF_RANGE; observed TIMESTAMP_OUT_OF_RANGE.

- Future signature: expected TIMESTAMP_OUT_OF_RANGE; observed TIMESTAMP_OUT_OF_RANGE.

- Duplicate signature headers: expected INVALID_HEADERS; observed INVALID_HEADERS.

- Signed malformed JSON: expected INVALID_ENVELOPE; observed INVALID_ENVELOPE.

- Live-mode event: expected UNSUPPORTED_SCOPE; observed UNSUPPORTED_SCOPE.

- Connect event: expected UNSUPPORTED_SCOPE; observed UNSUPPORTED_SCOPE.

- Thin event: expected INVALID_ENVELOPE; observed INVALID_ENVELOPE.

- Unsupported event type: expected UNSUPPORTED_EVENT; observed UNSUPPORTED_EVENT.

- Passing snapshot type: expected VERIFIED:payment_intent.succeeded; observed VERIFIED:payment_intent.succeeded.
## Automated evidence

- Final Stripe runner: 13 unit tests passed, 13 expected observations matched, 4 deliberate unsafe-source controls caught. The controls bypassed signature rejection, removed live/Connect rejection, leaked raw payload into metadata, or removed the byte-order-mark fix; each failed the intended assertion in an isolated source copy. Application sources were not modified by controls. No temporary Stripe guard directories remain.
- Broader gate: 415 unit tests across 49 files, 52 selected integration tests across 8 files, typecheck, changed-file ESLint and production webpack build passed after the final source fix. The pre-dependency baseline was 402 unit tests, the same 52 integrations, and a successful build. All database-backed checks used an owned disposable database. No new Stripe route appeared in the production route list.
- The known Vite native-configuration compatibility warning was not suppressed. Next added generated build-type include paths to the existing tsconfig during isolated builds.
- The initial invalid-UTF-8 fixture expected the JSON rejection phase, but a direct SDK probe confirmed it rejects an original-byte signature earlier after replacement decoding. The tests now distinguish that SDK refusal from the strict-decoding refusal when a signature covers replacement text. Both reject. Separately, an added byte-order mark produced a real failing regression test; preserving that mark for strict JSON rejection fixed it, and removing that fix is now caught by a control. No rejection assertion was weakened into acceptance.
- Local correctness/threat review covered the new library, CLI, tests, configuration and pinned SDK verification path. This is not an independent security audit or a measured classification precision score on customer traffic.

## Protection and limits

The SDK's raw exceptions can include payload/header values, so none are returned or logged. Errors have a fixed message and bounded reason code. Metadata excludes data.object, customer/resource ids, request idempotency keys, signature values, endpoint secrets and original payload/hash. A run-unique private marker verified that omission; a deliberately leaking version failed the test. Metadata is frozen and cannot be forged by copying the capability or metadata shape.

Input is bounded to 128 KiB and the Stripe-Signature header to 2 KiB; exact limits have positive tests. Header and v1-signature counts are capped. At most two distinct secrets support rotation, each with explicit expiry checked per call. Old signatures beyond 300 seconds and future signatures beyond 30 seconds are rejected. No caller-controlled clock/tolerance is exposed.

The caller still owns and must limit/clean up its original body Buffer. No secure erasure of JavaScript strings is claimed. Reading a historical metadata capability is not a freshness recheck or permission to attach another body. There is no durable dedupe/replay detection; a fresh retry can verify again. A future HTTP handler must enforce transport limits while reading and must durably store protected data plus a work item before acknowledging delivery.

## Cleanup and application state

Final read-only checks found zero development webhook receipts, groups and decisions, zero remaining disposable databases, and HTTP 200 from the existing app on port 3000 and separate Express demo on port 3001. AI and proposals remain disabled. No development/shared-test reset or data seeding was performed. No app/worker restart or dashboard change was needed because this verifier is not wired into those processes. No provider request, support ticket, Slack message, model call or business action occurred.

## Next bounded slice

Add durable protected Stripe receipts and validation work items, with workspace/integration authorization and stable original Stripe event-id dedupe. Generate the protected projection inside the verified-byte boundary, recheck freshness/expiry before commit, and only then expose a test-mode HTTP acknowledgment. Keep Connect, live mode and thin events out of scope until separately implemented and reviewed. The existing synthetic UUID event endpoint must not be presented as a Stripe receiver.

Cursor installation is not needed for this checkpoint. Founder review of this report remains separate from automated execution success.

## Primary references

- [Stripe event format guidance](https://docs.stripe.com/events/set-up-events): snapshot events were chosen here to inspect delivered point-in-time payloads without fetching account data; thin events remain unsupported.
- [Stripe raw-body signature guidance](https://docs.stripe.com/events/manage-webhook-endpoints#signature-errors).
- [Pinned Stripe 23.0.1 verification source](https://github.com/stripe/stripe-node/blob/v23.0.1/src/Webhooks.ts).
