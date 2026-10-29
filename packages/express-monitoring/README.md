# SpekTrace Express monitoring (local pilot)

Captures completed HTTP 4xx responses from Express 4/5 and submits bounded events to the existing SpekTrace incident endpoint. It does not change the application's response, inspect response bodies, replay requests, or enable AI. Requires Node 20.19+ and an issued workspace ingestion credential. This package has no runtime dependencies beyond Node built-ins; Express is a peer supplied by the application.

## Install locally

This package is not published to npm. From the SpekTrace repository, run `npm run build:express-monitoring`. Create a local tarball with `npm pack ./packages/express-monitoring --pack-destination ./work/express-monitoring` after creating that directory. In the Express application, install the resulting tarball using `npm install ABSOLUTE_PATH_TO_TARBALL`. Do not use `npm publish` for this checkpoint.

## Sender identity (0.2.0)

`resolveAuthenticatedSender(request)` may synchronously return `{ principalKind: "client_id" | "api_key_id", principalRef: NONSECRET_UUID_ALIAS }` from your application's already authenticated principal. Return `undefined` when unknown. Configure the corresponding exact collector/service/environment binding with SpekTrace's private admin API first. The result is **integration attested**, not independent SpekTrace verification of the original request.

Never copy an untrusted client header into this callback, and never return/hash an API key or authentication secret. UUID syntax does not prove a value is nonsecret. Generate nonsecret aliases in your identity registry. The middleware does not read inbound Authorization or X-API-Key for sender identity.

A single valid UUID X-Client-ID header is forwarded separately as `reportedClientRef` and is always unverified. Duplicate/malformed header values are omitted. Callback exceptions, Promise results, getters and malformed/extra fields omit the sender and increment `senderOmitted`; the event and application response continue. Application/SDK metadata stays separate. A mapped UUID is not proof that the integration actually authenticated its caller.

Changing an event's sender claim or collector credential on retry conflicts. After credential rotation, provision new bindings explicitly; they are not inherited. See the main repository's `docs/sender-identity.md` for registration, revocation, immutable snapshots and synthetic founder-review checks.

## Body-off default example

```js
const express = require('express');
const { createExpressMonitor } = require('@spektrace/express-monitoring');

const app = express();
const monitor = createExpressMonitor({
  baseUrl: process.env.SPEKTRACE_BASE_URL,
  ingestionToken: process.env.SPEKTRACE_INGESTION_API_TOKEN,
  apiKey: 'payments-api',
  environment: 'default',
  client: { applicationName: 'Payments backend', applicationVersion: '1.0.0' },
});

// Mount before routes, parsers and error handlers to observe their completed 4xx responses.
app.use(monitor.middleware);
app.use(express.json({ limit: '32kb' }));
app.post('/payments', monitor.operation('/payments'), (req, res) => {
  res.status(400).json({ error: 'Synthetic payment rejected' });
});
app.listen(3001);
```

The middleware captures 4xx automatically after the response `finish` event. This means the server handed the response to its transport, not proof that the client received it. Aborted responses without `finish`, 2xx, 3xx and 5xx are excluded. Register one collector per application response; if installed twice, the first active collector owns that response.

`monitor.operation('/accounts/{accountId}/payments')` marks a matched route using its full OpenAPI template, including static mount prefixes. Place the annotation at the controller that actually handles the request, including nested routers. It never reads concrete parameters. A server-controlled `operationPath` string or synchronous resolver is also available. Do not put request URLs, concrete IDs, query strings or `baseUrl` into these templates. Without an explicit mapping the event uses `/__unresolved_operation__`, and its body is omitted. Complicated/unsupported templates are rejected rather than inferred. The existing server validator's supported-operation coverage is unchanged.

## Optional body capture

Bodies are never read by default. To opt in, add `captureSanitizedBody: req => req.body` only after assessing the application's data policy and upstream sanitization. The callback is trusted synchronous application code; it must be fast and return the complete, faithfully sanitized JSON body. Never return a selected fragment, invented replacement, or schema-friendly projection of the original request. Do not use this example on real payment/company data without addressing data-handling requirements.

The SDK copies plain JSON only: at most 8 levels, 200 total properties/elements, 512 UTF-16 units per string, 200 elements per array, and 32 KiB UTF-8. Sensitive keys, recognized secret-like/card-like/email values, redaction/omission placeholders, getters, custom prototypes, toJSON, cycles, sparse arrays and oversized bodies cause **whole-body omission**. No partial body is forwarded. The event is still captured, and the existing validator reports missing-body checks as unsupported rather than a confirmed mismatch. These heuristics do not guarantee detection of all sensitive data or repair a misleading callback.

The middleware does not read original URLs, query strings, cookies, authorization headers, client IPs or response bodies. Trusted callbacks must not copy those values into operation templates or captured bodies; a misconfigured callback can defeat the intended boundary. Five optional attribution headers are copied only if bounded/valid and unambiguous: `X-Spektrace-Application`, `X-Spektrace-Application-Version`, `X-Spektrace-Platform`, `X-Spektrace-Sdk`, `X-Spektrace-Sdk-Version`. Configured identity overrides incoming labels. Incoming labels are unverified claims, not identity or authorization. The middleware's package version is kept separate from the consumer SDK fields.

## Delivery and shutdown

Defaults: 64 total pending events (preparing + queued + in flight), 2 concurrent sends, 2-second absolute deadline per send. Maximum options: `maxPending: 256`, `concurrency: 8`, `timeoutMs: 5000`. Queue-full events are dropped **before** the body callback runs. A saturated or unavailable collector cannot hold the application response open. Synchronous callback work still uses the application's event loop, so keep callbacks fast.

Only fixed server-configured HTTPS origins are accepted, with HTTP allowed for localhost/127.0.0.1/::1 development. Credentials, path prefixes, queries and fragments are forbidden in `baseUrl`. Redirects are never followed. The ingestion credential appears only in the outbound authorization header. Response text and exception messages are never reported. HTTP 200/202 increments `delivered`; it acknowledges ingestion only, not successful validation/investigation.

`monitor.stats()` returns fixed counters plus pending/closed state. There are no automatic retries, durable buffering, background polling, or delivery guarantees across crashes. One UUID identifies each observation. Network uncertainty can mean an event was accepted even if the sender records failure; it does not retry.

On application shutdown, stop accepting requests, finish existing responses, `await monitor.flush(3000)`, inspect its boolean result, then call `monitor.close()`. Flush waits up to its deadline (maximum 10 seconds), returning false on timeout without silently discarding events. Close immediately stops admission, drops queued events and aborts in-flight transmissions. It is idempotent. The middleware does not install signal handlers or take ownership of the application's server.

## Check without reading code

The repository's `npm run verify:express-monitoring` uses disposable test databases and temporary servers, with AI disabled. It demonstrates a real Express 400 retaining its status/body/header, an explicitly captured synthetic amount string becoming a mismatch through the worker, and the default body-off case becoming unsupported for missing body. It also checks duplicate submission and rejected credentials through the existing checkpoint. It does not connect a real company or change the running development database.

To inspect the temporary incident yourself, set `SPEKTRACE_APPMON_VERIFY_SCREENSHOT_PAUSE=120000` for that command, then open the temporary dashboard link printed in its report. The server stays up for two minutes, then stops and its disposable database is removed. Look for the amount string mismatch, an unapproved incident, and AI disabled. The separate body-off fixture should report missing-body unsupported validation. This does not modify the normal localhost:3000 dashboard.
