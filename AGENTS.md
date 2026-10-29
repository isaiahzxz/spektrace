<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## SpekTrace evidence and privacy conventions

- Work in this complete checkout; any synced ChatGPT `sources/` tree is read-only reference material.
- Preserve existing incident/request validation, credentials, Stripe, migration history, audit and outbox behavior. Make additive, verified changes.
- Treat README/checkpoint claims as historical claims. Report fresh executed checks, fixture versus real integration coverage, and all incomplete/failed cases separately.
- Never print .env, credentials, authorization/cookies, raw provider bodies or rejected model text. Outbound capture is explicit and bodies are off by default; selected-field projections retain types/presence only.
- Report normalized configured operations, nonsecret aliases and explicit collection coverage. No concrete URLs, query values, inferred customer identity or complete-traffic claims from sampled data.
- Distinguish request-contract mismatch, observed response drift, explicit identifier association and causation. Timing alone never proves cause. Imported contracts/baselines do not establish deployed behavior.
- Use owned disposable databases/queue namespaces for tests. Some nominal unit/integration suites reset their target; never point broad suites at development or a shared test database.
- Use `npm run export:snapshot -- --check` before distributing a snapshot. Export allowlists main source directories and excludes private/generated/work files; this is not a full content DLP scan. Never archive .env into distributed artifacts.
- Keep verification JSON files machine-readable and command logs separate. Do not report an overall pass when execution failed or acceptance checks were not evaluated.
