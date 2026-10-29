import Link from "next/link";
import { panel, secondaryAction, focusRing } from "./styles";
import { CopyTextButton } from "./copy-text-button";
export function ObserverSetup({
  integration,
  hasCredential,
}: {
  integration?: { key: string; provider: string; environment: string };
  hasCredential?: boolean;
}) {
  const identity = integration ?? {
    key: "your-integration",
    provider: "your-provider",
    environment: "staging",
  };
  const code = `import { createOutboundObserver } from "@/lib/integration-observations/outbound-fetch";\n\nconst observer = createOutboundObserver({\n  collectorOrigin: "https://your-spek-collector.example",\n  providerOrigin: "https://your-provider.example",\n  ingestionToken: process.env.SPEKTRACE_INGESTION_API_TOKEN!,\n  integration: ${JSON.stringify(identity)},\n  // Response shapes are OFF unless responsePointers is configured.\n});\n\nconst response = await observer.fetch(url, requestOptions, {\n  operation: { method: "POST", path: "/your-operation" },\n});\n// Consume response normally; flush at a bounded lifecycle boundary.\nawait observer.flush();`;
  return (
    <section id="setup" className={`${panel} scroll-mt-6 p-4 sm:p-6`}>
      <h2 className="font-medium">Set up outbound capture</h2>
      {hasCredential !== undefined ? (
        <p className="mt-3 text-sm text-st-muted">
          {hasCredential
            ? "An active workspace ingestion credential is recorded. Use its private server copy."
            : "No active ingestion credential is recorded. Create one on your server before sending observations."}
        </p>
      ) : null}
      <ol className="mt-4 list-decimal space-y-3 pl-5 text-sm">
        <li>
          <strong>Configure the observer on your server.</strong> Use a
          workspace ingestion credential, a fixed provider origin and nonsecret
          integration/environment labels.
        </li>
        <li>
          <strong>Send a call and flush delivery.</strong> Call through the
          observer wrapper, then run{" "}
          <code className="text-xs">observer.flush()</code> at a lifecycle
          boundary.
        </li>
        <li>
          <strong>Confirm receipt in Observations.</strong> Check the received
          call and capture report before interpreting failure counts.
        </li>
      </ol>
      <p className="mt-4 text-sm text-st-muted">
        This observer is a server module in the SpekTrace checkout. It is not a
        published installable SDK or an automatic provider connection.
      </p>
      <details className="mt-3">
        <summary
          className={`min-h-11 cursor-pointer py-3 text-sm ${focusRing}`}
        >
          Server setup example and collection policy
        </summary>
        <p className="mb-3 text-sm text-st-muted">
          Replace the example origins and operation with your actual
          configuration. Use your existing url/requestOptions variables. Keep
          the ingestion credential on the server. The separate admin token does
          not ingest observations.
        </p>
        <div className="overflow-x-auto rounded-md bg-st-code p-4">
          <pre className="text-xs leading-relaxed">
            <code>{code}</code>
          </pre>
        </div>
        <div className="mt-3">
          <CopyTextButton label="Copy observer setup example" text={code} />
        </div>
        <p className="mt-4 text-sm text-st-muted">
          Bodies and response shape collection are off by default. Opt-in{" "}
          <code>responsePointers</code> exports only selected presence/types.
          Sampling counts only wrapper calls; delivery can be missing or
          unconfirmed. The inbound Express 4xx package does not capture outbound
          responses.
        </p>
        <p className="mt-3 text-sm">
          Issue a workspace ingestion credential with{" "}
          <code className="text-xs">npm run ingestion:credentials</code>. Start
          the existing <code className="text-xs">npm run worker</code> to
          process comparisons. Report workflow outcomes explicitly using a
          nonsecret UUID alias and attempt; HTTP 200 is not a workflow-success
          signal.
        </p>
      </details>
      <Link
        href="/dashboard/observations"
        className={`${secondaryAction} mt-4`}
      >
        Check observations
      </Link>
    </section>
  );
}
