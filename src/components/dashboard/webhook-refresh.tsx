"use client";
import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { secondaryAction } from "@/components/dashboard/styles";

export function WebhookRefresh({ watch, subject = "receipts" }: { watch: boolean; subject?: "receipts" | "groups" }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    if (!watch || pending) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) startTransition(() => router.refresh());
    }, 4000);
    return () => window.clearInterval(timer);
  }, [watch, pending, router]);
  return <div className="flex flex-wrap items-center gap-3"><span className="text-xs text-st-muted">{watch ? "Pending checks refresh every 4 seconds" : subject === "groups" ? "Stored groups" : "Stored validation results"}</span>
    <button type="button" disabled={pending} onClick={() => startTransition(() => router.refresh())} className={secondaryAction}>{pending ? "Refreshing…" : subject === "groups" ? "Refresh groups" : "Refresh receipts"}</button></div>;
}
