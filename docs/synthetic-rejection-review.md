# Bounded synthetic C rejection review

Normal rejection diagnostics remain text-free. Source checks record only closed categories: supplied and required citation prefixes, atomic/mixed/unrecognized statement counts, snapshot presence, cited deployment resolution, hash equality, recorded comparison flags, and whether the comparison is supported. No rejected sentence, source ID, commit hash, or credential is included.

`npm run verify:synthetic-case-c -- --config-only` checks readiness without database access or provider requests.

Select `--case=A`, `--case=B`, or `--case=C` to check one fresh synthetic scenario. C remains the default. A is a string/integer mismatch; B is HTTP 400 with a passing integer body check; C adds repository, documentation, and deployment context. Existing workspace IDs, reset flags, unknown case IDs, and multiple cases in one invocation are rejected. Each invocation permits at most one provider request. No automatic A/B/C sweep or retry is performed.

`npm run verify:synthetic-case-c -- --review-rejection` creates one fresh synthetic workspace in the guarded test database and makes at most one live request. It does not reset the database, accept existing workspace/source identifiers, or retry provider failures. AI scheduling is disabled while preparing the fixture. The report includes existing-record checks and the count of inference outbox events (expected zero). Application process flags are restored afterward.

The optional review mode is off by default. Only the exact input digest minted by the fresh fixture factory can authorize display. A one-use, in-process capability is required to start the viewer; calling the text selector alone cannot grant it.

If validation rejects output, the viewer may show one screened sentence (at most 1,200 UTF-8 bytes) and supplied citation references. Unknown references are removed. Candidates containing detected secrets, email addresses, sensitive numbers, markup changes, or a known credential value are refused. Screening is heuristic and does not guarantee absence of sensitive data; the fresh fixed synthetic fixture is the primary scope boundary.

The viewer binds only to 127.0.0.1 on a random port with an unguessable path. It serves plain text, forbids caching and framing, rejects cross-origin requests, and expires after five minutes. The sentence is not written to incident records, application logs, or report files. The user may open the local URL for human review; do not copy its contents into ordinary logs. Source-rule candidates are diagnostic aids, not proof that a rejected statement is correct. Human review remains incomplete until explicitly performed.

Offline tests exercise actual screening, diagnostics, plaintext response headers, token/host/origin checks, one-use capability, size limits, and expiry. The viewer tests stub only the fixture authorization boundary. A successful offline run is not a live-model quality result. No support-ticket integration or corrected-payload feature is added.
