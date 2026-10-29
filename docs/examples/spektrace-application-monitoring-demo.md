# Synthetic application monitoring adapter (demo)

This adapter forwards **bounded HTTP 4xx failures** from a synthetic application to the existing `POST /api/internal/incidents` ingestion API. It does not add a second ingestion surface.

## Prerequisites

- SpekTrace app running locally (`npm run dev` + worker).
- A separately issued workspace ingestion credential in server-side `SPEKTRACE_INGESTION_API_TOKEN` (see `docs/ingestion-credentials.md`). The shared internal admin token no longer submits incidents. `SPEKTRACE_INTERNAL_WORKSPACE_ID` still selects the local dashboard workspace.
- Active pinned OpenAPI spec for `payments-api` / `default` (seed or import).

## Run once

```bash
npm run demo:application-monitoring
```

## Full live-process verification (guarded test database)

Runs an isolated Next dev server, worker, and Redis prefix against `TEST_DATABASE_URL` without resetting existing rows:

```bash
npm run verify:application-monitoring
```

Optional: `SPEKTRACE_APPMON_VERIFY_SCREENSHOT_PAUSE=120000` keeps the temporary server up for a dashboard screenshot.

The script sends a synthetic `400` on `POST /payments` with body `{ "amount": "100" }` (string vs integer schema). Workspace scope comes from the **Bearer token**, not the JSON body.

## Stop

Stop the dev server and worker. No background AI is enabled by this script.

## Security notes (pilot)

- Never commit `.env` or paste tokens into chat.
- The adapter redacts bodies using the same heuristic sanitizer as ingestion.
- Production payment traffic is **out of scope** for this demo.
