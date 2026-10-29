"use client";

import { useEffect, useState } from "react";
import { IconCopy } from "@/components/dashboard/icons";
import { focusRing, toolButton } from "@/components/dashboard/styles";

type CopyState = "idle" | "copied" | "failed";

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await Promise.race([
        navigator.clipboard.writeText(text),
        new Promise((_, reject) => window.setTimeout(() => reject(new Error("timeout")), 700)),
      ]);
      return;
    } catch {
      // Permission can be denied or the write can stall. Fall through to the selection copy.
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  previousFocus?.focus();
  if (!ok) throw new Error("copy command rejected");
}

export function CopyTextButton({
  text,
  label,
  visibleLabel = "Copy",
}: {
  text: string;
  label: string;
  visibleLabel?: string;
}) {
  const [state, setState] = useState<CopyState>("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 2500);
    return () => window.clearTimeout(timer);
  }, [state]);

  const copy = async () => {
    try {
      await copyText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  };

  return (
    <div className="flex flex-col items-start gap-2">
      <button type="button" onClick={copy} className={toolButton} aria-label={label}>
        {visibleLabel}
      </button>
      <p role="status" className="min-h-5 text-sm text-base-content">
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed. Select the text instead." : ""}
      </p>
    </div>
  );
}

export function IncidentIdCopy({ id, shortId }: { id: string; shortId: string }) {
  const [state, setState] = useState<CopyState>("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 2500);
    return () => window.clearTimeout(timer);
  }, [state]);

  return (
    <button
      type="button"
      className={`group relative inline-flex min-h-11 items-center rounded-md font-mono text-xs text-st-muted ${focusRing}`}
      aria-label={`Copy incident ${id}`}
      onClick={() => {
        void copyText(id).then(
          () => setState("copied"),
          () => setState("failed"),
        );
      }}
    >
      {shortId}
      <span className="absolute left-full top-1/2 -translate-y-1/2 pl-1 text-base-content opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100">
        <IconCopy />
      </span>
      <span role="status" className="sr-only">
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed. Select the text instead." : ""}
      </span>
    </button>
  );
}
