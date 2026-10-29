# Coherent integration-observability MVP cleanup — 2026-10-27

## Outcome and baseline
One path: Integrations setup/capture → Observations filters → Investigation evidence/outcomes. Primary navigation is Integrations, Observations, Settings (working appearance/runtime facts). Preserve all storage, credential separation, worker/outbox, historical pins, request validation and webhook/Stripe semantics. No migrations or data mutations needed. Main checkout is dirty; snapshot before edits: work/project-snapshots/9c909104-6d9a-452c-8821-bb99dfc6c1cc. Synced sources untouched.
Fresh baseline: 433 unit and 75 selected integration tests, four unsafe-copy controls, webpack build passed in report work/integration-observability/4048beaf-9351-4e35-a556-cb5a2c614556. Prior attempt 09e1e392 failed because standalone negative-control config discovered exported test copies; explicit include/exclude fixed discovery without weakening assertions.

## Decisions and local risk review
- Keep existing Tailwind/daisyUI tokens and native semantics. Consulted all five user sources: ReUI sidebar/empty/filters, 21st component catalogue, Spectrum docs, Kinetics library and PanelUI docs. ReUI's sidebar/menu and empty-title/description/action anatomy fits; reuse current controls rather than install unrelated component/motion stacks. ReUI raw markdown endpoints unavailable; no claim of installing source components. PanelUI is Expo-oriented, motion-heavy patterns not required for this task.
- Single left navigation, no second tab strip. Desktop rail expands on hover/focus, narrow layout uses modal navigation with Escape/focus return. Header is a breadcrumb only; theme settings remain functional in Settings.
- No invented integration connection: known outbound scopes derive from existing response-baseline configs, coverage reports and observed calls. Imported request contracts are separate supporting records, never proof of capture. Baseline configuration stays the actual authenticated admin API, documented in integration context; no client-side secret or fake connection button.
- Received-date filters use inclusive UTC start / exclusive next-day end; service/provider/environment scope stays explicit. Finding/HTTP-error filters do not reinterpret failure as causation. Dates filter calls; cumulative coverage and currently unmatched outcomes remain whole-scope and labeled accordingly.
- Read models scoped to the configured workspace; no new mutations/auth surface. Keep strict evidence parsing/hash checks, pinning and output limits. No raw input values, token, body or logs are rendered. Observation detail IDs unchanged. Legacy incident root links redirect preserving selection, not into the new observation namespace.

## Classification / deletion intent (recorded before deletion)
Core: integrations directory/detail/setup, observations list/detail/date filters, Settings appearance/runtime facts.
Supporting: request inspection/queue/pattern severity, request contract revisions/comparison/activation, received webhook/Stripe evidence, audit and historical request archive. Reachable via integration or settings context; none is primary navigation.
Compatibility: old dashboard incident query links → request evidence; consumer/specification index/support routes → appropriate core context. Pure legacy shortcut URL/store parsers retained with original tests; no browser storage is erased.
Obsolete and authorized for removal after tracing refs:
- context-sidebar.tsx, save-view-dialog.tsx, pin-control.tsx, shortcut-context.tsx, shortcut-store.tsx (actual extension checked): old request-only local shortcut UI. No core observer workflow depends on it; filters replace saved-view entry. Preserve localStorage untouched and tested parsers.
- section-nav.tsx: duplicated cross-product tab strip. Navigation moves into the shell.
- header-controls.tsx, incident-search.tsx: incident-only global search/activity and placeholder profile. Audit moves to Settings support link; theme stays Settings; search becomes explicit observation filters; calendar becomes UTC date inputs.
- overview-screen.tsx: obsolete request-error overview composition. Extract its still-used BucketChart into request-history-chart.tsx before removal; request archive keeps chart/evidence.
- server/dashboard/overview-data.ts, contract-summary.ts: unused request-overview aggregation after root/spec-list consolidation. No tests import them; request validation/history query services remain.
- server/dashboard/environments.ts: rail-only environment lookup. New integration/observation filters derive their real scopes from current persisted data.
- API dashboard search/activity/shortcut-status route files: old UI-only reads, no ingestion/worker use or retained caller. Keep header-data audit query; remove only dead search helper.
Legacy landing, consumer/spec-index and support screen bodies are replaced with compatible redirects; route files remain. Legacy overview branch and unused WorkspaceName removed from IncidentReview; inspector, queue, request test/approval and manual severity remain.

## Phases
1. Baseline/reference and classification — complete. Next: disposable browser review and final MVP/regression checks.
2. Navigation/retirements — complete. Files: dashboard-shell/frame, new navigation helpers; root/dashboard routes; remove duplicate imports and obsolete components; extract history chart; IncidentReview/spec/history/etc supporting views.
3. Integration setup/context — complete. New scoped read model and integration view/components/detail route, shared real observer setup guide; no speculative configuration mutations.
4. Observation filters/copy — complete. New query parser/helpers, extend read model with provider/UTC received dates/finding/status plus setup/empty metadata; concise list/detail/coverage disclosures with technical details. Preserve exact outcome/privacy semantics.
5. Verification/handoff — complete. Original unit/regression suite plus new filter/state/scope tests, types/lint/build, unsafe-copy controls. Disposable browser payment/CRM/timeout review and core/legacy nav, empty/filter/date/theme/focus checks at 1440/1280/390. Record exact deletions/dependencies and final known limits. Update README/DESIGN and deletion report; no production deployment or normal-store fixtures.

## Stop condition
Core path works and states distinguish no configured scope, awaiting capture, unknown coverage, no filter matches and processing/delivery gaps. All preserved regressions pass; no orphan imports or hidden second dashboard. Human review/production readiness remain separate.

Final evidence: docs/verification/mvp-interface-cleanup.md. Combined run 1dc75ab2 (440 unit,79 integration,4 negative controls,build), post-browser-fix 644843b8 (26 integration,controls,build), types and lint. Desktop/mobile Light/Dark reviewed; native Menu Escape and desktop Tab focus ring now observed. Original user data, migrations and dependency files preserved.
