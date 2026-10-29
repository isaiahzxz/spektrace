# SpekTrace interface and evidence contract

Spek is a quiet investigation workstation for developers tracing third-party API/integration changes and reported workflow outcomes. Extend the existing Centrifuge-inspired content treatment inside the Orchestrix-inspired shell; this milestone is not a visual redesign.

## Existing visual system

Use tokens from `src/app/globals.css`, not copied legacy palette claims. Dark: canvas #090A0B, sidebar/header #0D0E10, panels #121315, code #0C0D0F, borders #25272B, text #F4F5F7, secondary #B4B9C1. Light: warm canvas #F2EFEA, white panels, borders #E6E2D8, text #1C2430 and secondary #3E4C5F. Blue selects/actions, periwinkle dark links/focus, coral violations. Status meaning must remain readable without color.

Reuse shared panel, focusRing, secondaryAction, typography, theme controls and radii. Inter is for reading; JetBrains Mono identifies routes/IDs and expected-versus-received comparisons. No decorative gradients, glow, novel charts, animated entrances, fake metrics or default metric-card row. Real evidence determines density.

## Shell and navigation

One primary navigation: Integrations, Observations, Settings. The desktop icon rail expands on hover or keyboard focus over content; mobile Menu is a modal drawer with Escape and focus return. The header is a workspace/page breadcrumb. Theme controls are in Settings. There is no duplicate top tab strip, incident-only global search, activity/calendar/profile placeholder or saved-view/pin UI. Existing browser shortcut data stays untouched.

Integrations derives known scopes from outbound observations, capture reports and response baselines. Imported request contracts are supporting records, not proof that capture is configured. Show server setup and actual baseline admin API instructions without inventing a connection or browser credential flow. Request inspection, contract revisions/comparison, archive, audit, webhook and Stripe records remain supporting views. Legacy root incident links preserve selection.

Observation filters support integration, environment, provider, UTC receipt dates, finding and HTTP status. The final date is inclusive through an exclusive next-day boundary. Pagination and investigation back links preserve filters. Coverage/unmatched outcomes stay integration-scope-wide, independent of dates/finding filters, and say so. Distinguish setup, awaiting capture, unknown coverage, no filter matches, processing delay and delivery gaps.

## Primary integration investigation

1. **Observation list:** integration/provider/environment, configured operation, HTTP result or fixed transport error, duration to headers/error, deterministic comparison result and receipt time. Standard links open one investigation. Each row has a 44px minimum action and reflows into a stack on a phone.
2. **Coverage:** latest cumulative report per observer instance, visible unsampled/dropped/unconfirmed/pending calls, sample configuration/report time, unknown uninstrumented traffic, and unmatched outcomes. Counts are scoped to retained instrumentation reports, not complete impact. Empty coverage means unknown, not zero traffic.
3. **Investigation:** lead with observed drift/contract mismatch/no-response verdict and HTTP result separately. Show expected versus received **types** at selected paths. Values are not retained. Display baseline origin/version and provenance disclosure; observed samples are not provider promises.
4. **Workflow attempts:** show exact identifier association, separate attempts and occurrence/receipt times. A failure is a reported outcome, not a causation verdict. With no linked event, downstream success/failure is unknown. Show truncation and invalid evidence explicitly.
5. **Supporting calls:** same baseline/drift signature, configured affected operation, and any integration-reported legacy request check. That supplied reference does not establish identical request payloads.
6. **Investigation steps:** compare provider/client versions, inspect runtime traces and mappers, check auth/business rules/unrelated dependencies, and account for missing traffic/outcomes. These are deterministic prompts. No AI interpretation, correction or production action is invoked here.

## Evidence distinctions

Request-contract mismatch, observed response drift, response contract mismatch, explicit outcome correlation and causation are separate concepts. HTTP 200 is neither structural stability nor business success. A timeout has no response-shape verdict. Imported specifications/baselines and version headers do not prove deployment. Timing alone never establishes causation. A selected-fields match is not full JSON Schema validation or backend correctness.

Legacy request inspection retains its stored OpenUI evidence, separate generated explanations when enabled, original/candidate diff, synthetic test, and human acceptance. Passing a body/schema check does not prove upstream cause or business correctness. Acceptance and severity remain human decisions and do not rewrite original validation evidence.

## Required states and finish checks

Render loading under Suspense, an explicit store failure with refresh guidance, empty scope, invalid filters, missing scoped ID, pending worker, capture off, incomplete/unsupported comparison, no baseline, match, informational addition, drift and contract mismatch. Do not turn an unavailable store into an empty state.

Use labeled controls, visible keyboard focus, normal tab order and 44px targets. Keep long UUIDs/routes wrapped. Horizontal section navigation may scroll locally on phones; no page-wide overflow. Check desktop 1440, 1280 and phone 390 in Light/Dark. Exercise disclosures, scope filters, investigation links and keyboard navigation; record visual verification separately from automated tests.

Synthetic review data is labeled disposable. Do not invent connected customers, provider accounts, complete traffic coverage, performance results or causal claims to fill the interface.
