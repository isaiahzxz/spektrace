# Synthetic webhook signing

Optional server-configured historical revision selection is documented in [Configured contract revision](synthetic-webhook-configured-revision.md). Keys without that option keep the default behavior described below.

This opt-in local fixture verifies possession of a configured signing key over original request bytes. It does not verify any real provider, upstream user authentication, deployed revision, or business completion. No company source is connected. No tickets, Slack, model calls, replay or payment processing are added.

## Protocol and configuration

Use `npm run demo:signed-synthetic-webhook` with `SPEKTRACE_SYNTHETIC_WEBHOOK_ENABLED=true` and `SPEKTRACE_SYNTHETIC_SIGNING_KEYS_FILE` pointing to a private JSON file outside the repository. Do not paste that file or its contents into chat or a browser. No keys are issued automatically. The signing secret must be independent of the ingestion credential. Use cryptographically random 32-byte secrets, encoded as 64 lowercase hex characters. Each key must have a distinct id and secret. At most 20 configured keys.

The private file is an array of strict objects with `keyId`, `workspaceId`, `credentialId`, `principalRef` (lowercase UUIDs), `principalKind` (`client_id` or `api_key_id`), `secretHex`, and `expiresAt` (UTC ISO timestamp). An active sender binding must already map that principal for the specified workspace/collector and `synthetic-webhook-payments/default`. Configure key expiry; remove compromised keys and restart the launcher. Credential and binding revocations take effect from the database on later acceptance transactions. Key changes require restart. Public signing key IDs must never be reused for different key material or scope.

The launcher mounts **only** `POST /synthetic/signed-webhooks/payments` on loopback port 3002. Stop the separate unsigned fixture launcher before starting this one. Missing or invalid signatures never fall back to unsigned acceptance.

Required single headers: Authorization bearer ingestion credential, Content-Type `application/json` (optional `charset=utf-8`), X-Spek-Event-Id UUID, X-Spek-Key-Id UUID, X-Spek-Timestamp decimal Unix seconds, X-Spek-Signature `v1=<64 lowercase hex>`. No Content-Encoding. Bodies are bounded to 4096 bytes, decoded as strict UTF-8 only after successful HMAC verification, then parsed and sanitized using the existing narrow synthetic allowlist.

HMAC-SHA256 uses the configured secret bytes. The preimage is the following fields, in order, separated by a single LF, with one final LF before the original body bytes:

1. `synthetic-hmac-sha256@1`
2. `POST`
3. `/synthetic/signed-webhooks/payments`
4. keyId
5. workspaceId
6. credentialId
7. principalKind
8. principalRef
9. event UUID
10. decimal Unix timestamp
11. Original body bytes, without reserialization or normalization

Timestamp age must be at most 300 seconds and no more than 30 seconds in the future. Freshness, key expiry and collector validity are checked again after database lock waits. The sender is selected only from the configured key principal plus the live scoped binding, not arbitrary client headers.

## Acceptance and evidence

202 means the protected receipt plus validation outbox committed, not business completion. A valid freshly signed retry returns 200 for the same protected projection, event and mapped sender/binding. Signature timestamp and key rotation do not create new receipts. Changed retained data, omission policy, sender/binding or signed/unsigned provenance produces 409. Omitted originals are neither persisted nor hashed; changes only to omitted values can dedupe. Credential rotation starts a new event namespace.

401: invalid signature, expired key/request, wrong collector scope or unavailable sender binding. 400/413/415: invalid fixture payload, size or media encoding. 503: storage acceptance not confirmed. Retry an uncertain response with the same event id and a fresh signature. No separate replay action occurs.

The immutable receipt snapshot records protocol, public key id, sender/binding/principal ids, verification and signed times, key-possession basis, and `originalProviderVerified:false`. No secret, signature, original body or raw-body digest is stored. Old receipts remain unchanged after revocation; their provenance describes acceptance time. Legacy unsigned receipts display **Not verified · unsigned synthetic fixture**. Corrupt metadata displays **Verification provenance unavailable**.

## Review without reading code

Run `npm run verify:synthetic-webhook -- --webhook-signing --webhook-view --unit --guard-control --build`. This creates and removes an isolated database; it does not wipe the shared test or development database.

Look for these demonstrated outcomes:

- Valid signed event: 202, one stored receipt and validation job. A repeated event with a new timestamp/signing key: 200, same receipt and first verification snapshot.
- Change a single byte or event id without re-signing: 401 and no receipt/job. Old/future timestamps, wrong collector, unmapped/revoked sender and duplicated signature headers also fail.
- The intentional signature-bypass source copy must fail the tampering assertion. That proves the test detects an omitted check, rather than merely exercising the happy path.
- Receipt details say **Synthetic signing key verified**, show the sender reference and verification time, and explain that a real provider and business processing are unverified.
- A passing body check still does not establish backend/business correctness. Omissions remain incomplete rather than passing falsely.

For a temporary visual review, `node --import tsx scripts/review-webhook-receipts.ts --signed` creates only disposable synthetic data and serves the dashboard on port 3003 for up to 15 minutes. It uses ephemeral keys in memory, never a company key. Stop through its control file or Ctrl+C; the owned database is removed. Its Failed row is explicitly a display fixture; real worker failure behavior is covered separately by integration tests.

## Local installation

The additive migration is `20261022050000_synthetic_webhook_signing`. The guarded installer `node --import tsx scripts/activate-local-synthetic-webhook.ts --signing` allows only that pending migration on local `spektrace`, verifies existing records unchanged excluding the new null column, and adds no fixtures or credentials. Regenerate Prisma and restart the app/worker through the existing local run procedure. Keep AI and proposals disabled.

Framework references: [Express 5 raw parser](https://expressjs.com/en/5x/api/express/) and [Node 24 crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html). No dependency upgrade is required.
