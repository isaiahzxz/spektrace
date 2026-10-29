# Workspace ingestion credentials

Scope: issue, revoke and rotate ingestion-only workspace credentials. No dashboard authentication, new adapters, AI enablement, tickets or production actions.

Security review identified full incident responses and duplicate lookups outside the transaction as privilege/revocation risks. POST now returns only a receipt. Submission and duplicate lookup hold a shared credential lock; revocation/rotation take an exclusive lock. Credentials are random 256-bit secrets with domain-separated SHA-256 storage, strict format, and 90-day expiry. Shared admin tokens are no longer accepted for ingestion.

Operator CLI delivers the secret to a new private file outside the repository before database activation. On Windows inherited access is removed before writing, with access granted only to the current user SID. Existing files are never overwritten. A commit failure can leave a file for an inactive or uncertain credential; retain it and inspect metadata before retrying. No secret is printed.

Implementation files: Prisma schema/additive migration; credential-token and credential-secret-file modules; ingestion-credentials service; transaction-scoped incident submission; incident POST route; operator CLI; existing app monitoring demo/harness; unit and non-reset integration tests; operator documentation.

Verification: run credential unit tests, additive test-database migration, non-reset credential/adapter integration tests, typecheck, touched-file lint, all unit tests and an isolated production build. No test database reset and no development migration during verification.

Verification complete: 359 unit tests; 21 non-reset integration tests in a newly created dedicated test database; synthetic real HTTP application/worker flow in a second dedicated database with an untouched sentinel; typecheck, touched-file lint and isolated production build. Both temporary databases were dropped after successful verification. No blocking security-review findings remain. A first shared-test-database rerun observed outside worker mutations; the dedicated-database runs resolved that verification interference without changing assertions or stopping existing workers. A first build inherited a non-production NODE_ENV and failed; explicitly production mode passed.

Next step: apply the additive migration to the intended running installation, restart its app/worker, issue its first workspace key into a private file, and configure that integration's server-side secret. Development migration and real credential provisioning were not performed in this milestone. The operator CLI and the shared admin-token rejection are intentional compatibility changes described in docs/ingestion-credentials.md.
