# Workspace ingestion credentials

Each monitoring integration uses a separate, revocable credential for its workspace. A credential can submit captured 4xx incidents; it cannot read investigations, activate specifications, import context, or administer credentials. Service `apiKey` remains a service identifier, not an authentication secret. A key covers all services/environments inside its workspace in this milestone.

## Operator setup

Apply the additive migration to the intended database with the existing deployment procedure before using keys. This milestone's verification only migrated the guarded test database. No real company credential was issued. The local dashboard and remaining administrative endpoints retain the existing pilot authentication assumptions; this is not a full company authentication rollout.

The CLI uses `DATABASE_URL` and requires trusted operator access to the server. It does not accept a client-supplied workspace at a public management endpoint. Choose the actual workspace UUID, and an existing private directory outside the repository, inside your user profile. The directory and its ancestors down from the user profile must not permit other non-administrator users to write. On Windows the secret file removes inherited access before writing and grants the current user full access. On Unix the file is mode 0600. Never place tokens in chat, command arguments, source control, reports, or browser storage.

```text
npm run ingestion:credentials -- issue --workspace WORKSPACE_UUID --name "Application monitoring" --secret-file ABSOLUTE_PRIVATE_FILE_PATH
npm run ingestion:credentials -- list --workspace WORKSPACE_UUID
npm run ingestion:credentials -- rotate --workspace WORKSPACE_UUID --id CREDENTIAL_UUID --secret-file NEW_ABSOLUTE_PRIVATE_FILE_PATH
npm run ingestion:credentials -- revoke --workspace WORKSPACE_UUID --id CREDENTIAL_UUID
```

`WORKSPACE_UUID`, `CREDENTIAL_UUID`, and the file paths are placeholders to replace. Existing secret files are never overwritten. The CLI prints metadata only. Read the token locally from the private file and put it in the integration's server-side secret manager; the synthetic demo reads `SPEKTRACE_INGESTION_API_TOKEN`. The internal admin token remains separate. POST returns `{id, created, receivedAt}`, with 202 for a new incident or 200 for a duplicate, rather than the stored incident body.

Keys expire 90 days after issue; rotation issues another 90-day key and invalidates the old one atomically, with no overlap. Coordinate switching the integration immediately after rotation; brief rejected sends must retry using the replacement. Revocation is idempotent. A submission already holding the key's database lock may complete before revocation; once revocation returns, the old key cannot commit another incident or retrieve a duplicate receipt.

The file is written before database activation. If file delivery fails, no new key activates and an existing key is not revoked. If a database commit fails or its outcome is uncertain, retain any new file and use `list` to inspect its credential id before retrying. A failed operation may leave an unusable file; do not overwrite it or assume the old key was revoked. Restart the app and worker after generating Prisma clients/migrating a running installation.

For the local `spektrace` development database, apply pending migrations with `npm run db:migrate:deploy`, issue a credential with the CLI, sync server env from the private secret file (`npx tsx scripts/sync-ingestion-env-from-secret.ts ABSOLUTE_SECRET_FILE`), restart `npm run dev:local` and `npm run worker`, then run `npx tsx scripts/activate-dev-ingestion-demo.ts` to exercise HTTP ingest on port 3000.

## Founder review without reading code

Ask for a demonstration in synthetic workspaces A and B: the same event submitted with each key creates separate incidents; A's key cannot select B in the request; revoked/expired keys are rejected; rotation rejects the old key and accepts the replacement; keys cannot read incidents or activate a specification. The response should contain a receipt only. The dashboard's incident review, severity and approvals should remain unchanged.

Automated checks can prove these mechanical boundaries. They do not establish production readiness, secret-handling policy, deployment access controls or complete tenant authentication. No AI/model call, ticket, Slack notification, traffic replay or production action is part of this milestone.

## Verification commands

`npx tsx scripts/apply-test-migrations.ts` applies additive migrations only to the guarded, distinct `spektrace_test` target without resetting it. Run only the named credential/adapter integration test files for this checkpoint; other integration files include destructive reset helpers. Unit tests cover token parsing and private secret-file delivery. The full application monitoring verification script uses synthetic workspace keys and revokes its key on normal completion.

For reproducible isolation when other workers are running, `npx tsx scripts/verify-ingestion-checkpoint.ts` creates two uniquely named `spektrace_test_credentials_*` databases: one for the 21 integration tests, one for the HTTP/worker demonstration. Each includes a sentinel incident to detect unintended mutation. It applies migrations and drops only the databases it just created. It requires database-create permission and explicit operator authorization; it never resets an existing database. Temporary dashboard links expire when the check stops. `npx tsx scripts/build-with-test-database.ts` runs a production build with a fresh output directory, the guarded test database, and AI/proposals disabled.
