# Accounts, onboarding and notification workflow

## Review routes

- /sign-up and /sign-in: Google and email/password account screens. They show configuration status and do not pretend that unconfigured providers work.
- /dashboard/onboarding: add multiple integrations to a workspace, connect one at a time, and skip/resume later.
- /dashboard/integrations/new: add another integration using shared workspace preferences.
- /dashboard/settings/notifications: Slack, email or both; six independent alert categories; off/daily/weekly digest; selected-destination test; recent delivery attempts; terminal status instructions.
- /alerts/preview: a clearly illustrative compact alert. Real notification links use /alerts/DELIVERY_UUID and are scoped to the signed-in workspace in account mode.

The connection guide has five steps and reuses workspace notification settings. An integration record means setup intent, not capture. Setup needed, Waiting for first call and actual received-call evidence remain separate. Plans persist in PostgreSQL. Browser drafts are keyed by workspace, integration, provider and environment. The observer remains an in-checkout Node module; no published SDK or automatic provider connection is claimed.

## Enable account access

Set private server variables BETTER_AUTH_SECRET (at least 32 high-entropy characters), BETTER_AUTH_URL (canonical origin), GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SPEKTRACE_EMAIL_API_KEY and SPEKTRACE_EMAIL_FROM. Then explicitly set SPEKTRACE_ACCOUNTS_ENABLED=true and restart the application. Existing private .env was not modified. Migrations are additive.

Google's registered redirect URI must be the exact canonical origin plus /api/auth/callback/google. Email/password sign-in requires verification. Verification and reset emails use Resend; configure a verified sender/domain. Google verified-email sessions are supported. Automatic linking between sign-in methods is disabled. Test coverage exercises real local auth handlers and session records using a synthetic mail sink; real Google and email delivery still require operator configuration.

Verified users obtain their own workspace. Every dashboard reader/action and setup request resolves the authenticated workspace; it does not accept a browser-supplied workspace ID. Ingestion credentials and the private operator admin API retain their separate authorization boundaries. Local review mode remains available with account mode off; do not expose that mode publicly. Configure trusted proxy headers and shared rate-limit storage before multi-instance production use; the current auth limiter is per process. No independent production security audit or load/SLA claim is made.

## Slack and email

SPEKTRACE_NOTIFICATION_DESTINATIONS defines private aliases. In account mode, Slack aliases must include their workspaceId; another workspace cannot select or deliver to them. Email uses the verified workspace owner's address. A server-configured to list is permitted only for local-review mode. URLs, OAuth secrets and API keys are never returned to the browser.

Example shape (replace placeholders privately):

    {"team-slack":{"kind":"slack","workspaceId":"WORKSPACE_UUID","url":"https://hooks.slack.com/services/PRIVATE_VALUE"},"email":{"kind":"email"}}

The settings UI can choose either channel or both. A test targets one saved selected channel. The existing worker processes delivery; npm run notifications:worker is an optional separate process. Restart an existing worker after updating. Delivery remains off by default. No external messages were sent during implementation.

Checked alert categories are enforced when findings are queued and again before delivery: response structure, response contract, timeout/transport, provider 5xx, newly linked failed outcomes, and capture/processing trouble. Unchecked findings are excluded from digests. Pending digests are cancelled if category selections change. Capture reports can be cumulative; a warning does not establish a provider outage. No recovery is inferred from quiet traffic.

Findings are grouped by tenant, integration/provider/environment, operation and evidence signature. Updates require a 15-minute cooldown plus new selected impact or volume milestones (10, 100, 1000...). Outcome counts can be partial because the observer and linkage remain bounded. Each cycle batches up to 100 new observations and 100 groups. Digest candidates are limited to 100 and disclose truncation.

Daily digests cover the preceding 24 hours after a UTC day boundary; weekly digests cover the preceding seven days after Monday UTC. An offline worker sends the latest digest on return rather than every missed period. Digests summarize retained evidence in checked categories, not complete API traffic.

## Notification-to-window workflow

Slack/email messages link to one compact alert route. It displays the saved finding and currently available validated call, pinned baseline and related outcome evidence, then offers Open dashboard for the full investigation. The in-app preview requests a 760 by 780 resizable browser popup. Browser/app policy can choose a tab instead; an explicit same-tab link is provided. External Slack/email links cannot force an OS popup. A desktop companion application was not created.

A notification UUID is not an authentication capability. Account mode requires sign-in and workspace ownership; sign-in retains the requested alert destination. Selected alert details and related outcome associations do not establish causation.

## Delivery and status

PostgreSQL stores preferences, grouping memberships and durable delivery attempts. Requests use a five-second deadline, stable IDs and bounded retry/backoff with at most five attempts. Lost leases are recovered; an uncertain receiver acknowledgement can duplicate delivery. Slack incoming webhooks cannot guarantee deduplication. Sent means the receiving service accepted a message, not that a person read it.

The legacy generic HTTPS webhook transport remains server-compatible. It signs timestamp + '.' + exact JSON body with HMAC SHA-256 and sends x-spektrace-delivery-id, x-spektrace-timestamp and x-spektrace-signature. Receivers must verify freshness/signature and deduplicate IDs. It is not a primary channel choice in the new UI.

npm run status and npm run status -- --json remain operator commands using the private configured admin credential. They report captured calls, recorded change signatures, outcomes, reporting timestamps and coverage limits. They are not a newly published end-user CLI or an account-session token flow. No dashboard visit is needed for the command.

## Verification

npm run verify:notifications creates/drops an owned temporary PostgreSQL database, deploys migrations, runs policy/auth/tenant/onboarding/channel/category/compact-view tests, and keeps command logs separate from JSON reports. Auth verification and provider delivery use synthetic sinks; no real Google/provider/mail/Slack account is contacted. The unchanged integration-observability regression command is retained.
