# Triage Grouping v2

Milestone 3 of Historical Revisions → Sender Identity → Triage Grouping → Validation & Evidence.

New investigation groups distinguish **canonical integration-attested sender + pinned contract revision**, while preserving workspace, service, environment, HTTP method, safe operation, finding signature and a 15-minute received-at window. This is bounded triage correlation, not proof of a common upstream cause.

## Who can share a group

The sender key comes from the canonical registry id after checking the incident's immutable attestation against its collector id, claim, binding and workspace/service/environment. A header, display name or sender alias alone is insufficient. A valid historical attestation still counts after its mapping/credential is revoked; revocation does not rewrite the incident's past.

Revision proof requires the pinned spec's exact workspace/service/environment, id and SHA-256 to match structured stored validation evidence. Evidence must have a checked time, consistent outcome, validator and scope, and correctly shaped findings. A mismatch needs nonempty findings; a passed check needs none. Supported body checks need the matching HTTP method and a matched path. Missing, malformed or inconsistent proof creates an incident-specific unknown revision key and a null group `apiSpecId`. No active-revision fallback occurs.

Unknown, reported-header-only, legacy or inconsistent sender snapshots each get an incident-specific unknown sender key. They do not merge into a shared “Unknown client.” Two legitimate aliases can share a group only when explicitly mapped to the same canonical sender. Different senders/revisions remain separate even when their body mismatch looks identical. Different windows/findings/operations remain separate even for the same sender/revision.

These checks validate recorded associations; integration attestation is not independent SpekTrace verification of the original caller, and a historical interval remains an operator assertion.

## Legacy preservation and concurrency

Migration `20261022030000_sender_revision_grouping` adds `groupingVersion`, `senderGroupingKey` and optional canonical `senderId` to investigation groups. Existing groups receive version 1 and `__legacy_unspecified__`; memberships, prepared evidence and explanations are not moved/rebuilt. New groups are version 2 and cannot join those legacy groups. Database uniqueness includes both grouping version and sender key. A workspace-scoped foreign key and key/id check constrain canonical group metadata.

Assignment checks an existing membership before creating any group. Reprocessing an old incident returns its original group without an orphan v2 group, membership increment or new preparation scheduling. A new membership increments once and schedules one deduplicated preparation event. Concurrent uniqueness conflicts retry the whole transaction; all writes roll back together on a failed attempt. The existing retry bound remains four.

No automatic regroup or historical sweep is run. The existing bounded backfill command still means assigning only previously ungrouped incidents; it does not migrate old memberships and was not run for local activation.

## Evidence and product behavior

Preparation remains a bounded manifest of included incident references. Group identities are stored for routing, not added to agent evidence or explanation inputs. AI and payload proposals are not enabled. Ingestion, validation results, approvals, severity, incident queue and consumer-report attribution semantics remain unchanged. No new dashboard panel is introduced in this milestone.

Unknown singletons favor avoiding false correlation over collecting every possible repeat failure. There is no cross-window root-cause grouping, sender authentication service, tenant rollout or exhaustive malformed-payload claim yet.

## Founder review without reading code

The synthetic check should show:

1. Same sender, same revision, same operation/finding/window → one group.
2. Same mismatch from another sender → a different group.
3. Same sender on another historical revision → a different group.
4. A matching spoofed header or missing identity → separate unknown incidents, not that sender's group.
5. Revoking a mapping preserves earlier grouping evidence. Duplicate processing does not increase membership twice.
6. Reprocessing an existing legacy incident leaves its old group, preparation and explanation records alone.
7. The prepared manifest contains only its group's incidents; no model call or approval happens.

Automated results prove those mechanics. Human review must still establish whether a real application's sender and deployment records are truthful and useful; no company corpus has been accepted by these tests.

## Safe verification and installation

`npm run verify:sender-grouping -- --unit --guard-control --build` creates one uniquely named disposable test database, installs the local Express package into a disposable consumer, runs current sender/history/credential/adapter checks plus grouping checks, then the existing grouping/preparation suite. The latter uses its own Redis namespace and resets only the new disposable database. Unsafe source-copy controls test historical fallback, spoofed identity upgrade, missing sender dimension and incomplete evidence proof. Running application source is not mutated. Only newly created DB/consumer artifacts are removed afterward; the package tarball is retained. Existing shared databases/worker queues are not reset.

Install the additive migration to the intended local database and restart app/worker with the regenerated client. Existing group metadata gains legacy markers, with no reparenting or new sender mappings. Keep AI/proposals disabled. Production-size index build/lock timing and staged multi-instance rollout have not been evaluated.

Local installation used `npx tsx scripts/activate-local-sender-grouping.ts`: it guards localhost `spektrace`, refuses unexpected pending migrations or enabled AI/proposals, compares existing records before/after excluding only the three new group columns, and reports safe version counts. Installation and restart are complete locally. There are three retained v1 groups and no new v2 group or sender binding created just to demonstrate the feature.

No support tickets, Slack, real model requests, business-API replay, automatic corrections or production actions are included.
