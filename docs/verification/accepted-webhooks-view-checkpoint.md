# Accepted Webhooks view — 2026-10-22

Verdict: implemented and reviewed locally using synthetic data. Not a production authenticated dashboard or real webhook-provider evaluation.

## Behavior

- New horizontal navigation destination `/dashboard/webhooks` and read-only detail `/dashboard/webhooks/[receiptId]`. Existing 4xx incident queue and review actions stay separate.
- Lists receipt reference, acceptance time, endpoint/service/environment, pinned revision and Pending/Passed/Mismatch/Incomplete/Failed state. Twenty receipts per page, stable received-time/id ordering. Service/environment scope survives detail and back links. Invalid scope fails closed; missing, foreign and out-of-scope receipts use the same unavailable view.
- Detail shows stored sanitized JSON, protection-policy omissions, revision id/hash, runtime uncertainty and field-level expected/received findings. Unsupported protection formats are withheld, not dumped as raw JSON. Raw errors, collector credentials and omitted original values are not serialized.
- If detail protection/provenance metadata is malformed, it reads Incomplete and “Selection provenance unavailable” rather than asserting a verified pin or an unqualified Passed result. This corrupt-record path has a regression case.
- Both pages state: “Accepted for validation. Business processing is not confirmed.” A passing check is explicitly body-schema-only.
- Pending results refresh every four seconds while visible. Completed/failed states stop automatic polling. Refresh is also available manually. No new mutation, replay or approval control.
- Loading, empty, unavailable-store and invalid-filter states are distinct. Table becomes a stacked list on narrow screens; JSON and identifiers wrap. Existing palette/shell maintained. New inputs and actions are at least 44px high.
- Like the existing local dashboard, pages are development-only; production requests hit notFound before dashboard rendering. No new public receipt API was added.

## Verification

Fresh final command: `npm run verify:synthetic-webhook -- --webhook-view --unit --guard-control --build`.

- 395 unit tests passed across 45 files; includes four new display/query/markup cases.
- 25 integrations passed: 12 historical revision, 10 webhook acceptance/queue and three receipt-view tests. View cases cover all five states, scoped list/detail isolation, pagination, omission visibility and unsupported stored-payload withholding.
- Five isolated source-copy controls caught intentional unsafe changes: edge privacy omission, receipt/outbox atomicity, detail workspace-scope removal, unsupported payload disclosure and historical active-revision fallback. Application sources were unchanged by controls.
- Changed-source ESLint and typecheck passed. Production webpack build passed and includes both new routes. Route inclusion is not permission to serve the dashboard in production.
- An earlier full unit invocation hit the existing five-second database-backed AI harness deadline. It passed in isolation and the final full run passed under the original deadline; no assertions or timeouts were weakened. The first timeout's precise cause was not established.

## Browser review

A temporary loopback Next server used a newly created disposable database/workspace. HTTP synthetic acceptance created receipts; real body validation produced Passed, Mismatch and Incomplete. A Pending receipt was processed during review and the browser automatically changed to Mismatch, showing the completed time and findings. The Failed row was an explicitly seeded display fixture; actual terminal queue failure is covered separately in the webhook integration suite.

Observed Dark desktop at 1440 and 390, Light desktop at 1280 and mobile at 390. No page-wide horizontal overflow at measured 1280/390 widths. Full desktop review column was visible. A real Tab key moved focus, `:focus-visible` was true, and a painted 2px ring was captured on Refresh receipts. Environment filtering to an unconnected value showed the empty scoped view. The incomplete receipt showed omission name `email`, while stored JSON contained only amount.

Preview server stopped and its disposable database was removed. Temporary viewport override reset. Development receipt count remained zero. Existing development app and worker remain running; the app was restarted to load the current Prisma client. Express demo was not restarted. AI and payload proposals remain disabled. The local new page is open with its truthful empty state.

## Founder review without reading code

1. Open `http://127.0.0.1:3000/dashboard/webhooks` or choose Accepted webhooks in the horizontal navigation. The development workspace currently has no accepted webhook receipts, so expect an empty list.
2. For populated examples without changing that workspace, run `node --import tsx scripts/review-webhook-receipts.ts`. It creates a new disposable test database and serves synthetic examples on loopback port 3003. It auto-stops after 15 minutes or can be stopped with Ctrl+C. It does not reset an existing database.
3. Open a Mismatch receipt: amount is stored as a string, Expected is integer and Received is string. Check the pinned revision and acceptance caveat.
4. Open Incomplete: email is listed as omitted; its original value is absent from the payload. Failed is a display fixture, not a real provider event.
5. Automated reproduction uses the final command above. Review passed/executed counts and the intentional guard failures. These results demonstrate synthetic mechanics, not real-customer payload precision.

Screenshots are saved separately as founder review artifacts. No customer/provider integration, dashboard sign-in, support tickets, notifications or business execution were added.
