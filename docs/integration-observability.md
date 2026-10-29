# Integration observability: local pilot

## Instrument an outbound call

Import `createOutboundObserver` from `@/lib/integration-observations/outbound-fetch` in server code inside this checkout. This is an explicit wrapper, not global instrumentation or the inbound Express adapter.

```ts
const observer = createOutboundObserver({
  collectorOrigin: 'https://collector.example.test',
  ingestionToken: process.env.SPEKTRACE_INGESTION_API_TOKEN!,
  providerOrigin: 'https://provider.example.test',
  integration: { key: 'crm-contact-sync', provider: 'example-crm', environment: 'staging' },
  sampleRate: 1,
  // Omit responsePointers to keep response shape capture OFF.
  responsePointers: ['/count', '/results'],
  providerVersionHeader: 'x-api-version',
});
const correlation = { kind: 'workflow' as const, id: crypto.randomUUID(), attempt: 1 };
const response = await observer.fetch(providerUrl, requestOptions, {
  operation: { method: 'POST', path: '/contacts' },
  callId: crypto.randomUUID(), attempt: 1, correlation,
});
// Your application consumes the original response normally.
// Report the actual workflow's final result separately; HTTP 200 is not that result.
await observer.outcome({ correlation, outcome: 'SUCCEEDED' });
await observer.flush(); // explicit lifecycle boundary; bound shutdown time
observer.close();
```

Use a long-lived observer per integration/origin, not per request. Correlation IDs must be nonsecret UUID aliases, never raw user IDs, bearer tokens, or API keys. The configured operation is a trusted application annotation; the wrapper checks the method/origin, not whether that template really matches a concrete URL. No concrete URL or body values are exported. Arbitrary headers are never forwarded. Provider-version headers are limited to `stripe-version`, `x-api-version`, `api-version`, with bounded numeric-prefix values.

Constructor options are application code, **not automatically loaded environment flags**. Capture pointers default empty, sampling defaults 1 (all instrumented calls), pending limit defaults 32 (max 128), delivery concurrency 2 (max 8), collector deadline 2000 ms (max 5000), selected-body deadline 500 ms (max 2000), body read 32768 bytes. Fixed collector/provider origins require HTTPS except loopback HTTP. Collection/transport messages are fixed codes; original provider exceptions are rethrown to the application unchanged.

Selected field reads cover at most 16 conservative JSON pointers, 6 levels deep, max 100 selected array elements. They retain root/field types, presence and array element types, never values. Object field renames cannot be inferred. Extra/unselected fields are not discovered. An observed field addition is informational; required presence and selected types from a contract are checked. Other JSON Schema keywords are outside this comparison's scope. Incomplete capture is not a pass.

## Existing ingestion credentials, new bounded event types

`POST /api/internal/integration-observations` accepts strict version-1 observation or coverage envelopes from `src/lib/integration-observations/contract.ts`. `POST /api/internal/workflow-outcomes` accepts final outcome events. Both use workspace ingestion bearer credentials. Workspace comes from the credential; body scope cannot select a tenant. Envelopes are JSON, max 32 KiB and bounded read time. No compressed body or arbitrary logs/body/header fields are accepted.

An observation is deduplicated by workspace + source event UUID and by integration + environment + call UUID + attempt. Outcome identity is integration + environment + correlation kind + UUID + attempt. Retained evidence is immutable; changing it on retry conflicts. A new workflow attempt needs a new attempt number and keeps previous attempts intact. Reusing the same outcome identity with a new timestamp is a conflict; retries must resend the original event. A network timeout does not prove the collector rejected the event, so delivery-unconfirmed remains distinct from dropped.

Observation/outcome, audit and outbox work commit atomically. The existing worker processes deterministic comparison and exact outcome links. Lost published jobs have bounded reconciliation. These events do not schedule AI investigation or change incident approval/severity.

## Explicit response baselines

`POST /api/internal/response-baselines` uses the internal **admin** bearer token. An ingestion credential is refused.

Observed sample:

```json
{"action":"observe","observationId":"00000000-0000-4000-8000-000000000001"}
```

Stored contract (the referenced ApiSpec must already belong to this workspace, service and environment; its actual SHA is required):

```json
{"action":"contract","integration":{"key":"crm-contact-sync","provider":"example-crm","environment":"staging"},"operation":{"method":"POST","path":"/contacts"},"apiSpecId":"00000000-0000-4000-8000-000000000002","sourceSha256":"replace-with-the-actual-64-character-source-sha256","statusCode":200,"pointers":["/count","/results"]}
```

Creation is idempotent, versioned and inactive. Activate separately:

```json
{"action":"activate","baselineId":"00000000-0000-4000-8000-000000000003"}
```

UUIDs above are placeholders, not existing records. The placeholder hash is intentionally not executable. Baseline scope includes workspace, integration/provider/environment, operation, HTTP status, and selected-pointer policy. Activation is explicit, not proof of deployment. An accepted observation pins its baseline even if a new version is activated before the worker processes it. Different statuses/pointer sets require their own baseline. Existing ApiSpec activation and legacy request-validation rules are untouched.

## Investigation and impact

The read-only local dashboard links one response comparison to same-signature observations and explicit workflow attempts. It shows origin/version of the pinned baseline, optional provider-version header, collection gaps and a separately labeled related request check. A client-supplied related incident reference does not prove that incident's body was the identical outbound request.

No timestamp-nearness inference is used. A reported failed attempt is not caused-failure evidence. No outcome means unknown, not success. Different workflow retry attempts remain separate. Unmatched events may link when calls arrive later. A 100-link fan-out cap and 100-instance coverage display cap are disclosed. Cumulative coverage uses only the highest reported sequence per instance, not a sum of every snapshot. Delivery acknowledgments are not unique-call counts. Complete application traffic, overall impact and runtime causation remain unknown.

## Retention and rollout

No automatic record purge or retention deadline is configured. Operators must define and implement retention before real company data. Current demonstrations use local synthetic payment and CRM HTTP servers, PostgreSQL and Redis. No real provider account, gateway, logging vendor, production application, or AI model is connected by this milestone. Existing Stripe webhook support is retained as a separate test adapter, not evidence of generic webhook-to-workflow linkage.

Run `npm run verify:integration-observability` for disposable acceptance tests and clean JSON/separate logs, or `npm run review:integration-observability` for an expiring synthetic browser review. See README for the retained regression command and safe snapshot export. Human review should verify HTTP 200 drift, selected-field expected/received, explicit outcome association, uncertainty and coverage; automated pass does not complete that review.
