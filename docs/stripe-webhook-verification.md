# Stripe snapshot verification: local boundary only

This is the first Stripe-specific implementation slice. It verifies locally signed test fixtures and returns bounded event metadata. It does not accept or acknowledge webhook deliveries. There is no new HTTP route, receipt storage, outbox, dashboard panel, Stripe API request or live account connection.

## Supported input

The library uses the pinned official `stripe@23.0.1` SDK verification-only API. The caller supplies a raw `Buffer` and the original header pairs, such as Express `req.rawHeaders`. Do not run JSON middleware before preserving those bytes. Caller-owned HTTP code must enforce body and transport limits while reading; this library only bounds a Buffer already in memory.

Trusted server configuration supplies workspace UUID, integration UUID, `mode: "test"` and one or two distinct endpoint-secret records (public UUID, `whsec_...` value, explicit expiry). No API key is needed to verify signatures. No configuration file, environment flag or real secret is installed by this slice. Configuration is copied at verifier creation; later caller mutation does not update it. Expiry is checked each time verification runs. The library does not look up or authorize a workspace in the database; that remains a requirement before durable ingestion.

Only `payment_intent.payment_failed` and `payment_intent.succeeded` snapshot-shaped test events are supported. The event envelope requires an event id, event object marker, event type, created time, strict Boolean livemode and a data.object marked payment_intent. API version may be absent or null and is reported as unknown. This is a minimal envelope check, not validation of PaymentIntent fields or business correctness.

Live-mode events and non-null account/context scope are rejected. Connect/organization contexts, thin/v2 notifications and other event types are unsupported. The original event's created time is metadata, not the signature's freshness clock: an old event with a fresh delivery signature can verify.

Limits: 128 KiB body; 2 KiB Stripe-Signature header; at most 8 header components, 5 v1 signatures, 128 original header array entries and 2 configured secrets. One canonical decimal timestamp and at least one lowercase hexadecimal v1 signature are required. Duplicate Stripe-Signature headers and duplicate timestamps are rejected. Bounded non-v1 signature components are ignored; v0 alone is not verification. Current/rotating secrets are accepted only while unexpired. Signature age may be at most 300 seconds; future timestamps may be at most 30 seconds ahead of the server clock. These are fixed policies, not request parameters.

## Protection and provenance

SDK exceptions are discarded because they may contain raw payload or signature data. Rejections expose only a fixed message and a small reason code. Strict UTF-8/JSON parsing follows signature verification. A byte-order mark hidden by SDK decoding is preserved for strict JSON rejection, and invalid UTF-8 cannot yield a verified result.

The returned in-memory capability resolves only through a private WeakMap. Copying or serializing its shape does not reproduce verified metadata. The metadata contains configured workspace/integration/public secret ids, event id/type/created time, reported API version, signature timestamp, verification time, test-mode flag and `configured_endpoint_secret_possession` as its basis. It contains no payment object, customer id, request idempotency key, raw payload/hash, signing secret or signature header. Metadata is frozen. Original Buffer cleanup remains the caller's responsibility; JavaScript strings and caller memory are not claimed to be securely erased.

The capability attests metadata only. It must not be used to authorize attaching an arbitrary body later, infer a customer identity, select an OpenAPI revision, confirm business processing, or send a 2xx acknowledgment. Reading old metadata is not a freshness recheck. A future durable projection must be generated inside the verified byte boundary, with authorization, freshness/expiry rechecks and transactional storage before acknowledgment.

No durable replay protection exists in this slice. Verifying a fresh retry again is expected. The future dedupe namespace must include the trusted integration scope and original Stripe event id; the synthetic endpoint's UUID-only event path is not used or relabeled as Stripe.

## Founder review without reading code

Run `npm run verify:stripe-boundary` in the SpekTrace repository. It uses generated secrets and synthetic events held in memory, requires no credentials or database, and makes no provider requests. It runs 13 unit tests, four intentional unsafe-source controls, then saves an expected/actual report at `work/stripe-verification/results.json`. No secret or payment object is included in that report. A prior result file is removed before execution, and a failed run exits nonzero without replacing it with a success report.

Look for valid local signatures verifying, a changed byte and wrong secret failing, stale/future timestamps failing, duplicate headers failing, malformed JSON and added byte-order mark failing, and live/Connect/thin events being rejected. Confirm the report says deliveryAcknowledged false, payloadStored false, databaseTouched false and humanReviewComplete false. These labels describe this runner, not production readiness.

Do not register a Stripe destination or point Stripe CLI at Spek yet: no Stripe acceptance endpoint exists. The next bounded slice is durable protected Stripe receipt plus validation work item, stable event-id dedupe, and only then an HTTP acknowledgment. This will require an explicit protection policy and workspace/integration authorization. No support tickets, Slack, replay execution or model calls are part of this step.

## References

- [Stripe: event formats and receiving events](https://docs.stripe.com/events/set-up-events). Snapshot format is intentional here because payload drift needs delivered point-in-time data without fetching account resources; thin format remains unsupported.
- [Stripe: raw-body signature requirements](https://docs.stripe.com/events/manage-webhook-endpoints#signature-errors).
- [Pinned Stripe SDK verification implementation](https://github.com/stripe/stripe-node/blob/v23.0.1/src/Webhooks.ts).
