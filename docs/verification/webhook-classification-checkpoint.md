# Webhook classification checkpoint — 2026-10-23

Verdict: demonstrated locally for the bounded synthetic corpus. This is not a real-provider or staging-readiness certification.

21 expected-versus-actual cases matched. There were 11 accepted receipts, 7 grouped receipts and 5 groups. The selected integration suites passed 47 tests across 7 files. Ten isolated unsafe-source controls were caught in the preceding run. Final typecheck and changed-file ESLint passed. No application code or schema changed, so a production build and the full unit suite were not repeated for this test-only slice. Vite reported its existing configuration-loader compatibility warning; no warning was suppressed.

## What you can review without reading code

- Revision correctness: a decimal 100.5 was accepted while version 1 required an integer. Version 2 allowed numbers, but delayed validation still found a mismatch against version 1. A fresh 100.5 submitted under version 2 passed. A retry after activation returned the original receipt and retained version 1.
- Sender correctness: A and B used independent synthetic signing keys and configured sender mappings. A spoofed X-Client-ID and API-key header did not change A into B. Those untrusted header values were not accepted as identity.
- Group correctness: three string-vs-number mismatches from A under version 2 formed one group. B stayed separate. Missing and null amount stayed separate from each other and from string drift. The older revision stayed separate.
- Validation honesty: missing amount is a required-field mismatch; omitted email makes the body check incomplete; unsupported grouping constraints remain ungrouped even when validation found a mismatch. An event accepted without a revision did not fall forward to a newly active revision.
- Retry correctness: identical events returned HTTP 200 with the same receipt; receipt, outbox and grouping-decision counts did not increase. A changed body reusing the same event id returned 409.
- Rejections: malformed JSON, arrays, object-valued amount, unknown extra fields, oversized bodies, empty bytes, forged signatures and invalid collector credentials did not create receipts.

The checks prove matching within this corpus, not a statistically measured precision rate across customer traffic.

## Important limits

The route selects the active specification at acceptance. It does not infer which historical contract a newly replayed legacy payload originally belonged to, and the contract does not prove what is deployed. Empty bytes are rejected before storage, while an empty JSON object is stored and later fails the required-field check. Extra fields are rejected by the narrow synthetic allowlist; general lenient validation and arbitrary legacy partner payloads are not demonstrated. Signing proves possession of a configured synthetic key, not an original provider's identity. These are material limits before sending a prospect general replay instructions.

Requests used real loopback HTTP, independent synthetic HMAC construction and the actual acceptance service. Validation used the actual worker dispatcher directly; Redis delivery, background scheduling and queue timing were not tested by this corpus. No model, real provider, business processing, replay into a customer application, notifications or support tickets were involved.

## Dashboard review

The normal local page is http://127.0.0.1:3000/dashboard/webhooks/groups . It remains empty because this checkpoint does not seed development data. Corpus receipt ids were disposable and their database has been removed; there are no surviving corpus dashboard links. The JSON artifact is an observed record, not an interactive dashboard.

For a separate visual demonstration, run `node --import tsx scripts/review-webhook-receipts.ts --grouping` from the SpekTrace repository. Follow the preview URL it produces, then Drift groups → Open group → View receipt. That existing disposable preview demonstrates two signed mismatches; it does not rerun all 21 corpus cases. Stop it normally to remove its own preview database.

To reproduce the complete corpus, run `npm run verify:synthetic-webhook -- --webhook-corpus --webhook-signing --webhook-view --webhook-grouping --webhook-groups-view --guard-control`. It creates and removes its own isolated database and does not reset shared test or development databases. Results are written only after corpus assertions succeed to `work/webhook-classification/results.json`; an old results file is removed before the run.

## Expected versus actual observations

Identifiers below are replaced by the fixture's readable revision/sender labels. HTTP 202 means stored for asynchronous validation, not business success.

### Accepted under v1, validated after v2 activation

Expected: {"apiSpecId":"1.0.0 integer","senderId":"Synthetic sender A","validation":"MISMATCH","grouping":"GROUPED"}

Observed: {"apiSpecId":"1.0.0 integer","senderId":"Synthetic sender A","validation":"MISMATCH","grouping":"GROUPED"}

### Same sender and drift, different value

Expected: {"apiSpecId":"2.0.0 number","senderId":"Synthetic sender A","validation":"MISMATCH","grouping":"GROUPED"}

Observed: {"apiSpecId":"2.0.0 number","senderId":"Synthetic sender A","validation":"MISMATCH","grouping":"GROUPED"}

### Equivalent v2 drift merges

Expected: {"apiSpecId":"2.0.0 number","senderId":"Synthetic sender A","validation":"MISMATCH","grouping":"GROUPED"}

Observed: {"apiSpecId":"2.0.0 number","senderId":"Synthetic sender A","validation":"MISMATCH","grouping":"GROUPED"}

### Different signed sender stays separate

Expected: {"apiSpecId":"2.0.0 number","senderId":"Synthetic sender B","validation":"MISMATCH","grouping":"GROUPED"}

Observed: {"apiSpecId":"2.0.0 number","senderId":"Synthetic sender B","validation":"MISMATCH","grouping":"GROUPED"}

### Spoofed sender headers do not override signing identity

Expected: {"apiSpecId":"2.0.0 number","senderId":"Synthetic sender A","validation":"MISMATCH","grouping":"GROUPED"}

Observed: {"apiSpecId":"2.0.0 number","senderId":"Synthetic sender A","validation":"MISMATCH","grouping":"GROUPED"}

### Missing required amount

Expected: {"apiSpecId":"2.0.0 number","senderId":"Synthetic sender A","validation":"MISMATCH","grouping":"GROUPED"}

Observed: {"apiSpecId":"2.0.0 number","senderId":"Synthetic sender A","validation":"MISMATCH","grouping":"GROUPED"}

### Null type drift

Expected: {"apiSpecId":"2.0.0 number","senderId":"Synthetic sender A","validation":"MISMATCH","grouping":"GROUPED"}

Observed: {"apiSpecId":"2.0.0 number","senderId":"Synthetic sender A","validation":"MISMATCH","grouping":"GROUPED"}

### Passing number body check

Expected: {"apiSpecId":"2.0.0 number","senderId":"Synthetic sender A","validation":"PASSED","grouping":"NOT_A_MISMATCH"}

Observed: {"apiSpecId":"2.0.0 number","senderId":"Synthetic sender A","validation":"PASSED","grouping":"NOT_A_MISMATCH"}

### Redacted body remains incomplete

Expected: {"apiSpecId":"2.0.0 number","senderId":"Synthetic sender A","validation":"UNSUPPORTED","grouping":"NOT_A_MISMATCH"}

Observed: {"apiSpecId":"2.0.0 number","senderId":"Synthetic sender A","validation":"UNSUPPORTED","grouping":"NOT_A_MISMATCH"}

### Retry after activation retains original receipt and revision

Expected: {"http":200,"countsUnchanged":true}

Observed: {"http":200,"countsUnchanged":true}

### Changed payload reusing an event id conflicts

Expected: 409

Observed: 409

### Malformed JSON

Expected: {"http":400,"newReceipts":0}

Observed: {"http":400,"newReceipts":0}

### Empty request body

Expected: {"http":401,"newReceipts":0}

Observed: {"http":401,"newReceipts":0}

### Array body

Expected: {"http":400,"newReceipts":0}

Observed: {"http":400,"newReceipts":0}

### Wrong amount structure

Expected: {"http":400,"newReceipts":0}

Observed: {"http":400,"newReceipts":0}

### Unallowlisted extra field

Expected: {"http":400,"newReceipts":0}

Observed: {"http":400,"newReceipts":0}

### Oversized body

Expected: {"http":413,"newReceipts":0}

Observed: {"http":413,"newReceipts":0}

### Forged signature

Expected: {"http":401,"newReceipts":0}

Observed: {"http":401,"newReceipts":0}

### Invalid collector credential

Expected: {"http":401,"newReceipts":0}

Observed: {"http":401,"newReceipts":0}

### No active revision at acceptance never falls forward

Expected: {"apiSpecId":null,"senderId":"Synthetic sender A","validation":"UNSUPPORTED","grouping":"NOT_A_MISMATCH"}

Observed: {"apiSpecId":null,"senderId":"Synthetic sender A","validation":"UNSUPPORTED","grouping":"NOT_A_MISMATCH"}

### Unsupported grouping rule remains an ungrouped mismatch

Expected: {"apiSpecId":"3.0.0 integer minimum 500","senderId":"Synthetic sender A","validation":"MISMATCH","grouping":"EVIDENCE_UNSUPPORTED"}

Observed: {"apiSpecId":"3.0.0 integer minimum 500","senderId":"Synthetic sender A","validation":"MISMATCH","grouping":"EVIDENCE_UNSUPPORTED"}

## Review status

Automated classification checks passed. Founder review of the explanation and scope limits is still yours to complete; this report does not mark that human review approved. No Cursor installation or handoff is needed for this checkpoint.

