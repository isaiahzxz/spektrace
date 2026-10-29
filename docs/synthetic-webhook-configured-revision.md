# Configured contract revision for synthetic signed webhooks

This local synthetic option lets an operator choose a stored contract for a configured signing key. It supports testing a legacy sender against a known revision even when that revision is inactive. It does not infer the correct historical revision from a payload, prove which version was deployed, or verify a real provider.

## Configuration

The existing private signing-key file accepts one optional `revisionBinding` object on each key:

```json
"revisionBinding": {
  "apiSpecId": "<existing revision UUID>",
  "sourceSha256": "<that revision's 64-character lowercase SHA-256>"
}
```

These placeholders are documentation only. Obtain the revision id and hash from the existing specification record; never substitute a version label or a payload fingerprint. Keep the key file outside the repository and browser. No secret or credential is included in this example. No credential is issued or enabled by this feature.

Omitting `revisionBinding` preserves active-at-acceptance selection. Supplying it selects that exact id/hash within the collector's workspace, `synthetic-webhook-payments` service and `default` environment. Activation is not required. Wrong workspace, service, environment, content hash or missing record returns **422**, without creating a receipt or validation outbox. There is no fallback to an active revision. Invalid configuration shape fails startup with values withheld.

Restart the signed launcher after key configuration changes. Restart a worker that was loaded before this code before accepting configured-mode receipts. Existing default-mode receipts are compatible with the new reader and worker. No database migration is needed.

## Trust and retry behavior

The configuration is server-owned. An `X-Spek-Spec-Id`, `X-API-Spec-Id`, version or sender header cannot override it. Body fields outside the synthetic allowlist remain rejected. The HMAC request preimage remains `synthetic-hmac-sha256@1`; it authenticates the existing configured key/event/bytes. Revision selection comes from the server policy for that key, not an original provider's revision assertion.

Use a new public key id when changing revision policy; do not repurpose old key ids. Retry the same event with the same protected content, sender and selection policy. Configured-mode retries return the original receipt. Changing or removing a configured binding for an already accepted event returns **409** rather than altering its receipt. Switching an existing default-mode event into configured mode also returns **409**. New event ids may use new server configuration. Default-mode retries still keep their first pin across activation changes.

The immutable receipt selection is `configured-at-acceptance@1`, with revision id/hash and `runtimeVerified:false`. The inspector says **Server-configured revision · runtime unverified**. The validator reads that pin; grouping still separates revision ids and hashes. This is not permission to replay business requests, process payments, activate specifications or run AI.

## Review without reading code

1. Run `node --import tsx scripts/review-webhook-receipts.ts --configured-revision` from the SpekTrace repository. It creates a disposable database and temporary local preview on port 3003, with ephemeral synthetic keys held in memory.
2. Open the `mismatch` receipt from the generated preview. It should show **Synthetic payments 1.0.0**, **Server-configured revision · runtime unverified**, amount **100.5**, expected **integer**, and a mismatch.
3. Version 2.0.0 is active and permits a number; the selected inactive version 1 is what makes the decimal a mismatch. The preview does not prove a real deployment or partner identity.
4. Stop the preview normally using its existing control file or Ctrl+C. Its owned database is removed. Development records are not seeded.

Automated checkpoint: `npm run verify:synthetic-webhook -- --webhook-revision --webhook-signing --webhook-view --webhook-grouping --webhook-groups-view --webhook-corpus --unit --guard-control --build`. It creates and removes a new disposable database; it never resets shared test/development data. Review actual counts and failures rather than treating this document as execution evidence.

No real provider, generic JSON-schema mapping, staging deployment, business replay/export, Slack or support-ticket integration is added.
