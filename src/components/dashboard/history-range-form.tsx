"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { focusRing, primaryAction, secondaryAction } from "@/components/dashboard/styles";
import { historyHref, type HistoryStateFilter } from "@/lib/dashboard/history-range";

export function HistoryRangeForm({
  from,
  to,
  state,
  service,
  environment,
  error,
}: {
  from: string;
  to: string;
  state: HistoryStateFilter;
  service: string | null;
  environment: string | null;
  error: string | null;
}) {
  const router = useRouter();
  const [start, setStart] = useState(from);
  const [end, setEnd] = useState(to);

  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        router.push(historyHref({ from: start, to: end, page: 1, state, service, environment }));
      }}
    >
      <label className="text-sm">
        <span className="mb-1 block text-xs text-st-muted">From (UTC)</span>
        <input type="date" value={start} required onChange={(event) => setStart(event.target.value)} className={`h-10 rounded-md border border-base-300 bg-base-100 px-2 font-mono text-sm ${focusRing}`} />
      </label>
      <label className="text-sm">
        <span className="mb-1 block text-xs text-st-muted">To (UTC)</span>
        <input type="date" value={end} required onChange={(event) => setEnd(event.target.value)} className={`h-10 rounded-md border border-base-300 bg-base-100 px-2 font-mono text-sm ${focusRing}`} />
      </label>
      <button type="submit" className={primaryAction}>Apply</button>
      <button type="button" className={secondaryAction} onClick={() => {
        const params = new URLSearchParams();
        if (service) params.set("svc", service);
        if (environment) params.set("env", environment);
        const search = params.toString();
        router.push(search ? `/dashboard/history?${search}` : "/dashboard/history");
      }}>Reset</button>
      {error ? <p className="w-full text-sm text-error">{error}</p> : null}
    </form>
  );
}
