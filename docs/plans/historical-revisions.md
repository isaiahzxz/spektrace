# Historical revision selection

Scope: first milestone in Historical Revisions → Sender Identity → Triage Grouping → Validation & Evidence.
Express installation was freshly checked: 15 middleware tests pass; read-only counters show successful delivery and unavailable-collector failure with no pending events.

Use explicit immutable operator-asserted [from, until) bindings, separately allowlisted from advisory deployment events. Exact deployment/spec scope and revision hash required. These assertions do not independently verify runtime or sender identity. Imports serialize against selection by service/environment; duplicates preserve their original result. Unknown, overlap and overflow never fall back to the active revision. Default live ingestion remains active-at-ingestion, explicitly distinguished from historical selection. Old rows remain legacy/not-recorded.

No sender/grouping redesign, AI activation, support tickets, Slack, or production replay in this slice. After disposable verification, local installation was included so the running app could load the new client/schema: only the expected additive migration, with existing records compared before/after and no reset.

Verification: unit temporal/schema cases; isolated temporary database tests for import/auth, old/new schemas, rollback, gaps, overlap, dedupe, immutable provenance and concurrency; typecheck/lint/production build. Temp databases created and dropped individually; existing databases never reset.

Status: implementation verified and installed locally. 380 unit tests, 12 historical integration tests, typecheck, changed-file ESLint and production build passed. Isolated unsafe-fallback control failed its expected assertion; application source was unchanged by the control. Local migration applied with existing records unchanged and zero imported bindings. SpekTrace app/worker restarted; dashboard and administrative incident read returned 200; the separate Express demo remains unchanged. Human review of real interval assertions and production readiness are not established.
