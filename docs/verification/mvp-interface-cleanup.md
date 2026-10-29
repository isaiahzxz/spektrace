# MVP interface cleanup — 2026-10-28

Implemented in the existing checkout. Primary journey: Integrations setup / scope → Observations filters → Investigation. Settings exposes actual appearance/workspace facts. No migrations, normal-store fixtures, credential changes, approvals, severity edits or provider/AI calls were required.

## Screen dispositions

- Removed the old overview composition, duplicate horizontal navigation, contextual shortcut rail, request-only global search/activity controls and placeholder profile.
- Consolidated the specification index into Integrations supporting request-contract details; retained service revision/comparison/activation routes. Consumer index redirects to Observations with a notice where client filters cannot carry across. Support redirects to Settings.
- Retained request queue/inspection/OpenUI/candidate test/review, request archive/chart, audit and webhook/Stripe receipt/group screens as supporting views. Legacy root incident links preserve selection and inspection; existing observation IDs/routes stay valid.
- Response baseline configuration remains the real authenticated admin API, explained under each integration. This cleanup adds no browser mutation/authentication workflow or published SDK.

## Exact deleted files

- `src/components/dashboard/context-sidebar.tsx` — Old request-only contextual rail replaced by the single core navigation.
- `src/components/dashboard/section-nav.tsx` — Duplicate global tab strip replaced by shell navigation.
- `src/components/dashboard/header-controls.tsx` — Incident-only search/activity/calendar/profile controls removed; theme stays Settings and audit remains supporting.
- `src/components/dashboard/incident-search.tsx` — Old incident search control has no remaining caller; core observations use explicit filters.
- `src/components/dashboard/save-view-dialog.tsx` — Retired request-only saved-view dialog; stored browser data is untouched.
- `src/components/dashboard/pin-control.tsx` — Retired request/revision shortcut pin UI; underlying records are untouched.
- `src/components/dashboard/shortcut-context.tsx` — Retired shortcut context provider with no remaining UI consumers.
- `src/components/dashboard/shortcut-store.tsx` — Retired browser shortcut store UI wrapper; pure tested compatibility parsers remain.
- `src/components/dashboard/overview-screen.tsx` — Old overview composition removed; still-used chart moved to request-history-chart.tsx.
- `src/server/dashboard/overview-data.ts` — Old overview aggregate reader no longer used after entry consolidation.
- `src/server/dashboard/contract-summary.ts` — Old dashboard contract-summary aggregator no longer used; contract/history services stay.
- `src/server/dashboard/environments.ts` — Old contextual-rail-only environment reader no longer used.
- `src/app/api/dashboard/search/route.ts` — Old development-only header search endpoint has no retained callers.
- `src/app/api/dashboard/activity/route.ts` — Old development-only header activity endpoint has no retained callers; audit read remains.
- `src/app/api/dashboard/shortcut-status/route.ts` — Old development-only shortcut-status endpoint has no remaining shortcut UI caller.

Originals are recoverable in `work/project-snapshots/9c909104-6d9a-452c-8821-bb99dfc6c1cc`. No stored records or browser localStorage were deleted. README/DESIGN adjacent timestamped backups preserve their prior text. No dependencies were removed: retained inspector, adapters, validation, theme and worker paths still require their packages. Lockfile and private environment files were not edited.

## Verification

Baseline: 433 unit / 75 selected integration tests, four unsafe-copy controls and build passed (`4048beaf-9351-4e35-a556-cb5a2c614556`). An initial wrapper failure traced to snapshot test discovery; explicit single-file include and work/node_modules exclusions fixed discovery without weakening its exact expected unsafe failure.

Final combined acceptance: `1dc75ab2-469c-485b-83fd-485e80def936`, 440 unit tests / 55 files, 79 selected integration tests / 12 files, four unsafe-copy controls, webpack build including TypeScript, exit 0. Command: `npm run verify:integration-observability -- --mvp-cleanup --webhook --stripe-view --stripe-receipts --webhook-view --webhook-groups-view --webhook-signing --webhook-grouping --webhook-corpus --webhook-revision --unit --build`. The new four workstation tests exercised contract-only versus outbound configuration, capture/provenance/scope isolation, inclusive UTC receipt dates, and delayed processing visibility. A discovered detail-state override was fixed before the combined run.

Full ESLint: zero errors, two existing unused-import warnings in agent-evidence.test.ts and sidebar-scope.test.ts. Vite emits a config-loader compatibility advisory. Neither warning was suppressed.

## Browser evidence and limits

Review data is synthetic in an owned temporary database on port 3004, separate from the normal store. Payment HTTP 200 drift showed expected integer / observed string and a FAILED outcome. CRM HTTP 200 drift showed a SUCCEEDED outcome. Explicit-identifier association is labeled noncausal. Baseline provenance and scoped links were reviewed; same-day received-date plus provider/finding filters returned the payment drift only and its investigation back link retained those filters.

Dark 1440 and 390 layouts were visually reviewed. Mobile Escape initially lost focus; closing the native dialog before parent focus restoration fixed it. Retest showed Menu focused, :focus-visible true, solid outline. Additional final browser and post-fix build details follow below.

Remaining product limits: local development-only access, no production tenant authentication/retention purge/load benchmark, selected response presence/types only, incomplete traffic coverage, bounded reported-outcome linkage and no causation inference. No real payment/CRM connection, tickets, Slack or production action was added. Human acceptance is separate from automated checks.

Final browser checks: Light and Dark at desktop (1440 and 1280) and 390px phone layouts; reviewed screens had document scroll width equal to viewport width. The 1280px captures include the right edge; the browser's 1440px screenshot can still clip at 1404px, so no claim of one complete 1440px frame. Payment drift, CRM drift with SUCCEEDED, and timeout without drift were opened. Future-date filtering showed “No calls match these filters” while keeping cumulative coverage explicitly scope-wide. The normal workspace separately showed no configured outbound scope and unknown coverage, without adding fixtures.

Retained request revisions displayed the two synthetic revisions and their comparison (integer → number, Requires review). A blocking-prerender warning on that supporting route was traced to awaiting params before Suspense. Moving parameter resolution underneath the boundary removed the warning on reload. An old root incident link redirected to the same selected incident's inspector; stored OpenUI evidence, synthetic-test editor and manual severity remained available. No test, activation, approval or severity mutation was performed. Audit history loaded from its Settings link. Webhook/Stripe behaviors are covered by the selected regression suites; their empty supporting links were inspected rather than a new live Stripe submission.

Post-browser-fix verification: types exited 0, full lint remained zero errors / two warnings. `644843b8-1186-4db1-b1af-bc35c4a886d5` ran 26 relevant integration tests, four unsafe-copy controls and a fresh production build after the mobile focus, conditional investigation copy and revision Suspense fixes. The earlier full 440/79 suite covers the unchanged data/worker paths; it was not relabeled as a live-provider or human approval result.

Changed-file inventory: `work/integration-observability/mvp-cleanup-changed-files.json` compares against the pre-cleanup snapshot: 31 modified, 15 deleted, 12 added. Six earlier application-monitoring report/image files omitted by the curated snapshot are listed separately and are not attributed to this cleanup. No Prisma migration, package/lockfile, .env.example, AGENTS.md or tsconfig change from that snapshot. Private .env was not read into the report or modified. Documentation backups: `README.md.backup.mvp-cleanup-1793163940609`, `DESIGN.md.backup.mvp-cleanup-1793163940611`.

Screenshots are in the task outputs: mvp-cleanup-integrations-dark-1280.jpg, mvp-cleanup-crm-dark-desktop.jpg, mvp-cleanup-mobile-dark-focus.jpg, mvp-cleanup-timeout-light-mobile.jpg, mvp-cleanup-filter-empty-light-1280.jpg. The synthetic review has a 15-minute expiry and is stopped/removed after inspection. The normal local app remains at http://127.0.0.1:3000/dashboard.
