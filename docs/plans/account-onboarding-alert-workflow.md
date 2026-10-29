# Account onboarding and notification workflow

User-approved scope: Google plus email/password accounts, account-owned workspaces, multiple initial integrations, Add integration later, Slack/email/both, individual alert categories enforced in alerts and digests, retained test/history/CLI, compact alert view linking to a full investigation.

Architecture: Better Auth 1.7.14 with PostgreSQL adapter; verified-email sign-in and Google OAuth, operator-configured credentials. Session resolves workspace on every protected reader/mutation; never trust a browser-supplied workspace. Explicit account mode flag preserves the existing isolated local review until configured. Stored planned integrations stay distinct from received calls. Resend HTTP transport provides email without putting provider keys in browser code. Slack uses existing incoming webhooks. Existing webhook transport retained for compatibility, removed from primary choices.

Security review before implementation: protect assets (sessions, credentials, tenant evidence, recipient addresses). Trust boundaries are OAuth callback, auth cookies, workspace ownership lookup, notification links, and external delivery. Use vetted auth library state/PKCE/cookies/rate limits, verified email and no unsafe account linking. Every data route resolves authenticated workspace; no anonymous UUID link access in account mode. Notification links are identifiers, not bearer credentials. Recipients are operator-configured or verified workspace owners. Enforce selected categories when queued and delivered; cancelled channels do not send queued data. Keep private credentials untouched. External test sends require specific destination approval and are not part of automated verification. Account access remains opt-in while real OAuth/email configuration is absent; no production-readiness claim.

Phases:
- [x] Inspect code and capture unchanged baseline (0cd4322e-f29c-4ef9-9679-afe8804036b1).
- [x] Add account/session schema and verified sign-in, resolve per-account workspace for all dashboard paths.
- [x] Persist planned integration setup and multi-integration onboarding with later-add entry point.
- [x] Add Slack/email selection, category filtering, filtered digests, targeted tests/history.
- [x] Add authenticated compact alert view and popup/full-page fallbacks.
- [x] Verify isolated authentication/tenant/category/email/alert tests, unchanged regression gates, build/lint and browser flows.

Dependencies: operator must configure auth secret/base URL, Google OAuth credentials and mail sender/API key for real authentication and delivery. Do not request secrets in chat. Current local workspace stays reviewable while services are unconfigured.
