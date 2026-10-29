# Onboarding and notifications — 2026-10-28

Implemented in the existing writable SpekTrace checkout. Synced sources and private .env were not modified. No dependencies, prior migrations or existing records were deleted.

Review /dashboard/onboarding and /dashboard/settings/notifications. Integrations links to the six-step setup. Drafts are browser-local, workspace-keyed, and separate from verified receipt/baseline/outcome progress. No SDK publication, real provider connection, production login or baseline browser mutation was added.

Background features: grouped verified drift/contract/timeout/transport/5xx alerts, cooldown and volume/impact updates, optional daily/weekly UTC digests, signed HTTPS webhook or Slack incoming-webhook transport, durable leases/backoff/history, and a read-only authenticated status endpoint plus npm run status. The existing worker includes evaluation; an optional standalone worker is also available. Notification preferences default off and server destination secrets are never exposed to the browser.

Verification:
- Initial unchanged baseline command: npm run verify:integration-observability -- --mvp-cleanup --unit --build, report 3b84baf9-7838-4b7e-892d-c1283c78290c, passed.
- Final same acceptance command: b98c8373-07a2-4d75-bff5-bb9735618972, 448 unit tests, 26 selected integration tests, four expected failing unsafe-copy controls, production build passed.
- Dedicated notification verification: work/notifications-verification/8d753e72-246e-41a9-bd82-8dfb99c11b8e, 17 tests (8 unit and 9 integration), passed in an owned temporary database. Unit tests overlap the 448 count. Delivery failures/receipts use simulated transport; no real Slack/provider/receiver was contacted.
- Types passed. Full lint: zero errors, two existing unused-import warnings. Existing Vite native-config advisory remains.
- Additive migration installed locally; row counts of all 32 pre-existing tables unchanged. Prisma regenerated. No database reset.
- Actual read-only status command against the local app passed; normal capture remains empty with unknown coverage.
- Browser: all six setup steps, local draft persistence, valid generated example, empty evidence, invalid setup, absent destination error, desktop 1280 and phone 390, Light/Dark. Document width equaled viewport width at both sizes. Step changes move focus to the current panel. No baseline activation, credential issuance, real notification test or persistent notification worker was started during review.

Automatic approval review rejected a live notification-worker check because it could deliver workspace-derived data to an external destination. That command did not run. Isolated transport tests were used instead; external delivery remains disabled/unconfigured.

Limits: local development-only access; outbound observer still an in-checkout module; no production retention purge or load benchmark; bounded selected-field evidence and outcome linkage; notification scans are batched and outcome counts may be partial; at-least-once delivery may duplicate after an uncertain receipt, particularly Slack. No quiet-traffic recovery/health claim or causal inference. Refer to docs/onboarding-notifications.md for operation and signing details.

Task inventory and pre-edit copies are in ignored work/notifications-verification/change-inventory.json and work/notifications-baseline. Screenshots saved in this chat's outputs. No existing source file was deleted.
