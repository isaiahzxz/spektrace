# Read-only webhook group feed — 2026-10-23

Outcome: dev-only /dashboard/webhooks/groups and /groups/[groupId], using existing immutable grouping records. Group feed metadata: sender, revision, endpoint, received window and count. Detail has bounded member pages linking to protected receipt inspection. No payloads, headers, credentials or provider text in group read models. Service/environment and group-list page remain on detail/back/member links; receipt group links retain service/environment and return to the first group page.

Existing Spek shell, palette, focus styles and typography remain. Receipts/Drift groups are local view links under Accepted webhooks, not a second global navigation. Empty, unavailable store, invalid filter and out-of-scope states are distinct. New reads use fixed workspace plus filters and known grouping version; no writes or historical regrouping. Manual refresh only for groups.

Verify read-only DB fixtures for scope, stable 20-item group/member pages and sensitive-field omission; actual signed pipeline regression suites; intentional removed-workspace and payload-spread source controls; typecheck/lint/build; real signed disposable browser preview, keyboard and phone reflow. No migration, new auth, AI, replay, alerts, tickets, or provider connection. Status: implemented; automated verification and disposable browser review complete. Preview stopped and owned database removed.

