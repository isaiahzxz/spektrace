"use client";

import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { focusRing } from "@/components/dashboard/styles";

export function InspectionFrame({
  open,
  closeHref,
  label,
  inspector,
  children,
}: {
  open: boolean;
  closeHref: string;
  label: string;
  inspector: ReactNode;
  children: ReactNode;
}) {
  const router = useRouter();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const focusStart = () => {
      if (window.location.hash === "#synthetic-test") {
        const field = document.getElementById("sandbox-candidate");
        if (field instanceof HTMLTextAreaElement) {
          field.focus();
          return;
        }
      }
      closeRef.current?.focus();
    };
    focusStart();
    const frame = window.requestAnimationFrame(focusStart);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const focused = document.activeElement;
      if (
        focused instanceof HTMLInputElement ||
        focused instanceof HTMLTextAreaElement ||
        focused instanceof HTMLSelectElement
      ) {
        return;
      }
      router.push(closeHref);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, closeHref, router]);

  return (
    <div className="relative h-full min-h-0">
      {children}
      {open ? (
        <div className="fixed inset-0 z-40 flex justify-end">
          <button type="button" aria-label="Close inspection" className="absolute inset-0 bg-black/50" onClick={() => router.push(closeHref)} />
          <div role="dialog" aria-modal="true" aria-label={label} className="relative flex h-full w-full max-w-xl flex-col border-l border-base-300 bg-base-200">
            <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-base-300 px-4">
              <p className="min-w-0 truncate font-mono text-sm">{label}</p>
              <button ref={closeRef} type="button" className={`inline-flex min-h-10 items-center rounded-md px-3 text-sm ${focusRing}`} onClick={() => router.push(closeHref)}>
                Close
              </button>
            </div>
            <div id="incident-detail" className="min-h-0 flex-1 overflow-y-auto">
              {inspector}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
