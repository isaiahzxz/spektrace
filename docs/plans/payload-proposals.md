# Sandbox payload proposal slice

Outcome: an explicitly requested proposal can select one evidence-supported, lossless string-to-integer conversion, reconstruct a candidate locally, and show its pinned-spec validation result for human review. No request body or value goes to the model. Decimal/non-numeric strings, missing business values, redacted/incomplete evidence, and PASSED body checks abstain.

Pre-implementation threat-model review identified independent service/environment/spec checks, strict evidence plus fresh body validation, canonical safe-integer conversion, own-property JSON pointers, stale-source fingerprints, and no incident/approval/traffic mutation as required boundaries.

1. Implement bounded value-free plan contracts and local conversion, with positive and refusal tests.
2. Implement read-only workspace-scoped proposal service, pinned-schema sandbox validation, provider timeout/one request, and default-off local pilot action. Add scope, stale-source, redaction, malformed plan, and no-mutation tests.
3. Extend the existing sandbox with a separately displayed proposal and an explicit Use in candidate action. Do not call acceptance or replace a human-edited candidate automatically.
4. Verify offline tests, typecheck, lint, and build. Demonstrate synthetic integral-string success and decimal-string refusal without using a real model or resetting databases. Record limitations and founder-review steps.

No tickets, Slack, corrections to specifications, deployment actions, request replay, automatic retries, or historical sweeps. No migration is needed; proposal bodies are returned for local review rather than persisted. Existing human acceptance remains a separate operation.

Implemented this slice. Offline unit checks, typecheck/lint, and no-reset real-test-database simulation succeeded. Browser inspection verified the default-off state only. Production build result is recorded in the task report. Remaining checkpoint: one bounded real-model proposal run plus founder review, and enabled browser proposal/replace verification. No real provider calls were made for this milestone.
