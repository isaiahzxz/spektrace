# Sender Identity

Milestone 2 of Historical Revisions → Sender Identity → Triage Grouping → Validation & Evidence. This adds attribution, not sender-based grouping or production authentication.

## Trust labels

- **Integration attested:** the authenticated collector has an exact registered mapping for its submitted authentication-context alias. The result records what that integration attested; `originalAuthenticationVerifiedBySpekTrace` stays `false`.
- **Reported:** a forwarded `X-Client-ID` UUID is an unverified claim. Matching a registered UUID never upgrades it to a canonical sender.
- **Unknown:** missing claim, no exact mapping, revoked binding, or internal submission without authenticated collector context. Old incidents remain `legacy_not_recorded`.

Application/version, platform and SDK remain descriptive metadata. Service `apiKey` identifies the monitored service, not an authentication credential.

## Private registration

`POST /api/internal/sender-bindings` requires the existing pilot **admin** bearer. Workspace comes from that authentication. Its strict, 4 KiB JSON body requires `ingestionCredentialId`, `apiKey`, `environment`, `principalKind` (`client_id` or `api_key_id`), `principalRef`, `senderKey`, and `displayName`.

All references are nonsecret UUID aliases, normalized to lowercase. `senderKey` identifies the canonical sender inside a workspace; `principalRef` references an application-authenticated client/API-key record. The collector credential must belong to that workspace and be active. Mapping identity is `(workspace, collector credential, service, environment, principal kind, principal reference)`, without wildcards. Registry identity is `(workspace, senderKey)`. The same sender can have several explicit mappings.

New import returns 201 and one audit; an identical import returns 200 without another audit. A changed target/label under the same identity conflicts with 409. Invalid scope returns 400. `POST /api/internal/sender-bindings/{id}/revoke` revokes once and writes one audit. Reimporting a revoked binding returns its tombstone without reactivation. Targets and registry records are immutable in this slice; there is no edit/delete/reactivate operation. New mappings require a new credential or principal alias. Operator correction tooling is later work.

The shared pilot admin mechanism identifies a server/operator authority, not an individually authenticated employee. It is not a company administration rollout. Monitoring credentials cannot register/revoke bindings or read incidents.

## Capture and resolution

Incident submissions may include `senderReference: {principalKind, principalRef}` and/or `reportedClientRef` (a UUID). Only `senderReference` can resolve through the authenticated collector's exact mapping. Body-supplied workspace, collector id, canonical sender id or assurance is rejected. The POST response remains a minimal receipt.

Express package **0.2.0** adds synchronous `resolveAuthenticatedSender(request)`. Return the configured nonsecret alias from the application's already authenticated principal, or `undefined`. A thrown callback, Promise result, getter, extra field or malformed reference is omitted, increments `senderOmitted`, and leaves incident forwarding/application responses working. A single well-formed UUID `X-Client-ID` is forwarded separately as reported/unverified; malformed or duplicate headers are omitted. No inbound `Authorization` or `X-API-Key` is read automatically for identity. Existing client metadata does not become authentication evidence.

**Never return or hash a raw authentication secret.** A UUID-shaped API key is still a secret; syntax checks are not DLP. Generate nonsecret aliases in the application identity registry. Do not implement the callback by copying an untrusted header. SpekTrace does not independently verify what a custom integration did to authenticate the original caller.

## Stability and races

Each incident stores immutable collector/claim/canonical/binding provenance with selection time. Credential and binding row locks serialize resolution against revocation; a logical scope lock orders absent mappings against concurrent registration. Revocation can wait for an in-flight event to commit. Once it returns, future events cannot use the revoked grant. Older incident attestations remain historical records.

Event uniqueness stays `(workspace, source, sourceEventId)`. Identical retries preserve the original result, including an unknown result recorded before mapping import. A changed sender claim, reported reference or collector credential returns 409. In particular, a retry through a rotated credential conflicts with an event recorded by the old credential; fresh events remain unmapped until explicitly registered. Mappings are never inherited silently. Unchanged legacy retries retain their old result.

The private incident response exposes sender id, binding id, reported reference and provenance. No new dashboard panel or consumer report semantics are introduced. Sender identities remain outside agent evidence export. Contract selection, validation, grouping dimensions, approvals and severities stay unchanged. AI and proposals are not enabled.

## Founder review without reading code

Check the synthetic demonstration outcomes:

1. A registered authentication alias resolves to its sender and says **Integration attested; original authentication not verified by SpekTrace**.
2. The same alias in a client header alone stays **Reported**, with no canonical sender.
3. Another collector/service/environment/workspace/principal type stays **Unknown** unless explicitly mapped.
4. A revoked mapping cannot identify a new event, while the old incident keeps its original attestation. Identical retries keep one incident; changed sender claims conflict.
5. The Express HTTP check keeps the original HTTP 400 and response text, delivers both synthetic events, and stores no original authentication secret.

Automated checks prove these mechanics. A human must review the real application's identity source and callback before claiming verified customer sender classification.

## Verification and installation

`npm run verify:sender-identity -- --unit --guard-control --build` creates a new disposable `spektrace_test_history_*` database, runs unit and sender/historical/credential/adapter integration checks, verifies unsafe source copies fail their assertions, builds, and drops only that new database. Existing shared databases are not reset. The full unit suite belongs inside this wrapper because an existing test harness resets its database.

Additive migration: `20261022020000_sender_identity`. Regenerate Prisma and restart app/worker after installation. The migration creates no sender registrations and backfills no incidents. Install the 0.2.0 package in a consumer before configuring its new callback; the existing 0.1.0 demo keeps previous capture behavior until upgraded.

`npx tsx scripts/activate-local-sender-identity.ts` guards the exact local `spektrace` target, refuses unexpected pending migrations or enabled AI/proposals, applies only this additive migration, compares existing records before/after excluding new nullable fields, and reports safe metadata. It creates no mappings and requires an app/worker restart. This local installation has been completed; the separate live demo was not upgraded or given a synthetic identity.

No support tickets, Slack, real model calls, company data, business-API replay or grouping redesign is included.
