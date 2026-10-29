"use client";

import { RetryButton } from "@/components/dashboard/retry-button";

export default function IncidentsError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <main className="flex min-h-screen items-start justify-center px-4 py-16">
      <div role="alert" className="flex max-w-xl flex-col gap-3 rounded-box border border-base-300 bg-base-200 p-6">
        <h1 className="text-lg font-semibold">The incident screen hit an unexpected error</h1>
        <p className="text-base leading-relaxed text-st-muted">
          Nothing was changed. Details are in the dev server terminal. Retry once the problem is fixed.
        </p>
        <div>
          <RetryButton onRetry={retry} />
        </div>
      </div>
    </main>
  );
}
