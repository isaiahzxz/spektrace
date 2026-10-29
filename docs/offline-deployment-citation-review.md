# Offline deployment citation review

## Symptom

The source-word guard rejects a supported deployment commit comparison unless a repository excerpt is also cited. Conversely, attaching both citation types can make an unsupported comparison pass. These were reproduced independently with synthetic evidence, not recovered live output.

## Root cause

`src/server/deployment-context/retrieve-evidence.ts` computes `repositoryCommitMatch` from the selected repository snapshot and recorded deployment commit. `src/server/investigation/build-context-enriched-input.ts` includes that result and the recorded SHA in the model's deployment evidence.

The old citation guard in `src/lib/investigation/inference/explanation-claim-policy.ts` inferred required sources from words such as “repository,” without receiving the evidence input or checking the cited record's fields. `validate-explanation-output.ts` called that guard without the input it already held. The guard conflated a repository code assertion with a deployment-record metadata assertion.

## Fix

- Pass the actual input into source-citation validation.
- Recognize a bounded grammar of atomic recorded-commit match/mismatch statements. The object must be the selected repository snapshot. This is not a general natural-language fact checker.
- Require actual cited deployment records, a selected snapshot, valid full commit hashes, and agreement between every cited record's comparison flag and the hashes. Compare hex hashes without case distinctions.
- Permit deployment-only attribution only for those atomic metadata findings. Mixed prose keeps the existing repository citation requirement.
- Require an observed, verified comparison before a summary can repeat it. A hypothesis is insufficient.
- Reject recognized false comparisons even if both citation types were attached.
- Remove the blanket prompt instruction demanding both sources for every deployment-to-snapshot comparison. Do not add another prompt prohibition. Prompt provenance is versioned.

New failures use `UNSUPPORTED_DEPLOYMENT_COMPARISON` and the text-free `deployment_commit_comparison` diagnostic rule. Existing records are not rewritten.

## Evidence

Before the implementation, the new five-test suite produced three failures: the valid finding and valid summary were rejected, and a false comparison with both citation types was accepted. The existing code-content rejection tests passed.

An independent read-only review identified case-sensitive hash comparison as a hardening gap. Two additional tests failed before normalization, then passed after it. This normalization behavior also exists upstream in deployment retrieval; the guard now rejects inconsistent flags instead of trusting them. Upstream retrieval normalization is outside this patch.

Fresh verification after the correction: production build passed; typecheck passed; ESLint on the changed TypeScript files passed; 199 offline unit tests plus six non-database harness tests passed (205 total). The harness database-reset test was skipped. No provider requests or database resets were made.

## Regression and adversarial checks

`tests/unit/deployment-citation-scope.test.ts` covers 24 offline cases: supported match/mismatch statements and summary support; actual code assertions; mixed and compound claims; unknown or absent context; contradictory flags/hashes; a matching record that was not cited; conflicting cited events; hypotheses masquerading as observed support; unsupported causal claims; and hash-case equivalence. These tests use real validators and synthetic in-memory objects without a database or provider.

The independent reviewer found no exception that let atomic metadata support excuse a code-content assertion. This review is additional evidence, not a guarantee about arbitrary prose.

## Related limits

- The discarded live C finding cannot be reconstructed from source-prefix diagnostics. This review proves a rule defect and a narrow correction; it does not prove the exact rejected live claim was correct.
- Language outside the bounded grammar remains conservative. General citation correctness and semantic truth still require human review.
- No live model calls, database resets, approvals, spec activations, or corrections are part of this checkpoint.
- The working tree contains unrelated WIP and untracked implementation files. Verification covers this working tree, not an isolated known-good committed branch.

## Founder verification

Ask the coding agent to run:

```text
npx vitest run tests/unit/deployment-citation-scope.test.ts
```

Expected: 24 tests pass. The important distinction to inspect is that “the recorded commit matches the selected snapshot” may cite the deployment record that establishes it, while “the repository code serializes the amount” still needs a repository citation. A deployment record must not prove arbitrary code behavior or HTTP causation.

Normal application AI stays disabled when `SPEKTRACE_AI_INVESTIGATION_ENABLED=false`. This change has no new runtime toggle and does not enable inference. A separately bounded live C run is still required before claiming live verification.

## Status

DONE_WITH_CONCERNS: offline correction verified in the existing working tree; live Case C unresolved and no isolated committed-branch verification. No production readiness claim.

## Guidance applied

- [AI Skills: debugging](https://github.com/iliaal/ai-skills/blob/master/skills/debugging/SKILL.md), writing-tests, and verification-before-completion: reproduce before fixing, test actual behavior, independent adversarial review, and fresh checks.
- [AgentPatterns: Prompt Tinkerer](https://agentpatterns.ai/patterns/anti-patterns/prompt-tinkerer/): replace repeated prompt additions with a small evidence-aware rule.
- [AgentPatterns: Code-First Oracle Bias](https://agentpatterns.ai/patterns/anti-patterns/code-first-test-oracle-bias/): derive acceptance and rejection cases from evidence ownership rather than copying the old guard's expected result.
