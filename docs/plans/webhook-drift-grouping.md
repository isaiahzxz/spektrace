# Signed webhook drift grouping — 2026-10-22

Outcome: newly validated signed synthetic webhook mismatches receive a durable group keyed by workspace, service, environment, operation, verified sender, pinned revision/hash, structural finding fingerprint, and a server-received 15-minute UTC bucket. Receipt inspection shows the group/count/window or a stored exclusion reason. Acceptance and validation remain separate from business processing.

Only inline synthetic amount `type` and required-amount findings are supported in version 1. The canonical fingerprint includes expected and observed types, field and schema rule; no values, messages or omission fallback are hashed. All findings must pass the supported grammar. Unverified, incomplete, passed and unknown evidence cannot merge.

Security review completed before implementation: validate immutable signature snapshot against receipt scope and registry identity; use acceptance-time proof despite later revocation; validate pinned revision and final evidence identity; closed exclusion reasons; no UI-triggered grouping or historical backfill. Workspace composite foreign keys, unique full group dimensions, one immutable decision per receipt, groupId iff GROUPED, transactional receipt validation+decision, advisory group lock.

Steps: additive group/decision schema; bounded canonical finding helper; transaction-local grouping after validation; read-only receipt detail; real HTTP/database isolation/concurrency/rollback tests and deliberate missing-sender control; fresh unit/integration/type/lint/build; guarded local migration, runtime restart and disposable visual review.

Stop: no webhook AI/investigation link, corrections, replay, Slack, tickets, real provider, deployment association or production rollout. Existing completed receipts are not regrouped and display Not evaluated by this grouping version.

Status: implemented, freshly verified and installed locally. 400 unit tests (47 files), 42 integrations (5 files), seven deliberate unsafe-source controls, typecheck, changed-source lint and production webpack build passed. Deletion-protection regression failed against UPDATE-only triggers, then passed after both undeployed triggers were corrected to UPDATE OR DELETE. No shared migration was rewritten. Terminal unvalidated jobs display validation did not complete, not pending.

Real signed HTTP receipts in the disposable browser preview shared one group (count 2); a passing receipt stayed ungrouped. Light/Dark desktop and Light 390px were reviewed, with no horizontal document overflow at 1440 or 390. Local additive migration preserved existing records; no development fixtures/credentials/receipts were created. App and worker restarted. AI and proposals remain off. Temporary preview is removed after review.
