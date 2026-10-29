"use client";

import { RetryButton } from "@/components/dashboard/retry-button";

export default function DashboardError({
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  return (
    <main className="p-6">
      <section className="max-w-xl rounded-box border border-base-300 bg-base-200 p-5">
        <h1 className="text-lg font-semibold">The overview could not be shown</h1>
        <p className="mt-2 text-sm text-st-muted">Reload this screen. Stored incidents were not changed.</p>
        <div className="mt-4">
          <RetryButton onRetry={retry} />
        </div>
      </section>
    </main>
  );
}
