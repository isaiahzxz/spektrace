# Explanation rejection diagnostics

Rejected explanations remain failed. Their text is neither stored as validated output nor added to diagnostics. Diagnostic metadata does not turn a failed explanation into an accepted output.

New failures store a version 1 `explanationRejection` object in the run's existing `usageMetadata`; no migration is required. The verification report exposes it as `cases[].rejectionDiagnostic`. Token counts are read separately.

A synthetic example:

```json
{
  "version": 1,
  "field": "observedFindings.description",
  "itemIndex": 1,
  "rule": "source_citation_type",
  "requiredCitationPrefix": "rx-"
}
```

This means the second observed finding describes repository context without a repository citation. Indices are zero-based. `clauseIndex`, when present, identifies the clause after the existing sentence/comma/semicolon/conjunction splitting; it is not a byte offset. Only the first rejection is reported.

Fields, rules, and source prefixes come from closed allowlists; indices have fixed bounds. No rejected excerpts, property values, citation IDs, provider error bodies, or schema error messages are copied into these diagnostics. Unknown schema keys map to `$` (whole output), rather than exposing the key. Old, malformed, or unknown-version diagnostic objects read as unavailable.

Scope rules distinguish HTTP contract exclusion, response-before-validation wording, and validation-before-response wording. Citation rules distinguish missing citations, missing catalog entries, wrong source types, and unsupported summary context. Forbidden-output diagnostics include a stable zero-based index into `FORBIDDEN_OUTPUT_PATTERNS` in `validate-explanation-output.ts`; changing that ordering requires a diagnostic version update.

The bounded deployment commit-comparison policy checks the cited event's comparison flag against the actual snapshot and event hashes. Unsupported recognized comparisons use `UNSUPPORTED_DEPLOYMENT_COMPARISON` with rule `deployment_commit_comparison`. See `offline-deployment-citation-review.md` for the narrow atomic-statement scope, regression evidence, and live-verification limits.

## Founder verification without paid calls

Ask the coding agent to run:

```text
npx vitest run tests/unit/explanation-rejection-diagnostics.test.ts tests/unit/inference-rejection-persistence.test.ts tests/unit/explanation-correctness.test.ts
```

Expected: 49 tests pass. These tests use local fixtures; database and provider calls in persistence tests are mocked. They do not call the gateway, reset a database, or enable AI in the running application.

The checks demonstrate that:

- The captured, correctly scoped Case B explanation remains accepted.
- Unsupported causal/scope claims remain rejected.
- Rejections identify their field and rule without copying sensitive marker text.
- Source citation mismatches are located within an individual finding.
- Rejected outputs remain failed, do not populate `validatedOutput`, and do not schedule retries or change incident approval state.
- Diagnostics with extra text fields, untrusted names, unsupported versions, or out-of-range indices are refused.

## Limits and next review

Database persistence is covered by mocked worker tests in this checkpoint, not a fresh database integration run. No new model request was made. Earlier failures have no retrospective diagnostics. The guards remain heuristic: a diagnostic explains which check fired, not whether the model's claim was true or whether the check was too broad.

Before another paid run, review the offline checks. A separately authorized live run can then produce new diagnostics for rejected explanations. Human explanation review is still required before corrected-payload work.

This change adds no routes, UI controls, actions, or support-ticket feature. It has no runtime toggle and does not enable inference. Keep `SPEKTRACE_AI_INVESTIGATION_ENABLED=false` to leave normal application AI disabled.
