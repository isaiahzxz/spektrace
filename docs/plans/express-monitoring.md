# Express monitoring milestone

Build a locally installable Express 4/5 middleware package. Observe completed 4xx responses without changing application status, body, headers or next/error behavior. Default to no request body and unresolved operation identity. Only explicit server-configured OpenAPI templates can identify operations; never infer from URLs, parameters or mounted base URLs.

Security review: opted-in callback output must faithfully represent the request body. If any secret/protection/truncation/cycle/accessor/budget issue is detected, omit the entire body; never send a fragment as complete evidence. Selected client header labels are unverified metadata. The collector package version is not a consuming-client SDK version.

Implementation: standalone CommonJS/declaration package under packages/express-monitoring with Node built-ins only; 64 queued/preparing/in-flight events by default, 2 concurrent sends, 2-second absolute timeout; fixed upper configuration limits; no retries, redirects or response-body capture. HTTPS required except loopback HTTP. Explicit flush/close and fixed counters expose delivery loss without leaking event content.

Verification: real Express 4 and 5 fixture tests; opt-in protection tests; timeout/queue/redirect/abort/duplicate installation; standalone build and local packed-package consumer; isolated test-database HTTP ingestion followed by the actual worker with AI disabled. No reset of existing databases, no dev incident creation, no support tickets/Slack/AI enablement/dashboard changes.

Verified: 374 unit tests including 15 middleware fixtures against Express 4.22.3 and 5.3.0; 21 isolated non-reset integration checks; actual Express HTTP to Next ingestion to BullMQ worker, opted-in body MISMATCH/EVIDENCE_READY and default body UNSUPPORTED/REQUEST_BODY_MISSING; no AI calls. Temporary databases removed and sentinel unchanged. Serialized numeric-card regression test failed when its guard was deliberately removed and passed after byte-exact restoration. Package builds, packs locally and loads in isolated CommonJS and ESM consumers; root typecheck, changed-file lint and a fresh production build pass.

Root typecheck initially found Cursor activation helper typing errors; only environment string narrowing and the report checks type were corrected. Dependency audit flags five affected packages at high severity in the Next lint dependency chain (braces/micromatch/fast-glob/eslint-config-next), not Express or this zero-runtime-dependency package. No forced dependency downgrade or unrelated upgrade was made.

Next step: hands-on review of the local package setup before integrating an actual application. No package publication, development database writes, company traffic or AI activation were performed.
