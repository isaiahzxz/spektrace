"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useTransition } from "react";
import { toolButton } from "@/components/dashboard/styles";

const AUTO_REFRESH_MS = 5_000;

export function QueueRefreshControls({
  loadedAt,
  hasPending,
}: {
  loadedAt: string;
  hasPending: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const inFlight = useRef(false);

  useEffect(() => {
    inFlight.current = isPending;
  }, [isPending]);

  const refresh = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    startTransition(() => {
      router.refresh();
    });
  };
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  });

  useEffect(() => {
    if (!hasPending) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        refreshRef.current();
      }
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [hasPending]);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <p className="font-mono text-sm text-st-muted" aria-live="polite">
        {isPending ? "Refreshing…" : `Loaded ${loadedAt}`}
      </p>
      {hasPending ? (
        <p className="text-sm text-st-muted">Refreshing every 5s while a check is pending.</p>
      ) : null}
      <button type="button" onClick={refresh} aria-disabled={isPending} className={toolButton}>
        Refresh
      </button>
    </div>
  );
}
