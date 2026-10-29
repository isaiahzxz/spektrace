"use client";

import type { ReactNode } from "react";
import { useEffect, useSyncExternalStore } from "react";
import { focusRing } from "@/components/dashboard/styles";

const WIDTH_KEY = "spektrace-inspector-width";
const EVENT = "spektrace-inspector";
const MIN = 320;
const MAX = 560;

let width = 420;
const listeners = new Set<() => void>();

function readStored() {
  const raw = localStorage.getItem(WIDTH_KEY);
  const storedWidth = raw == null ? 420 : Number(raw);
  width = Number.isFinite(storedWidth) ? Math.min(MAX, Math.max(MIN, storedWidth)) : 420;
}

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void) {
  if (listeners.size === 0) readStored();
  listeners.add(onChange);
  const onStorage = () => {
    readStored();
    onChange();
  };
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

function currentWidth() {
  return width;
}

function setWidth(next: number) {
  width = Math.min(MAX, Math.max(MIN, next));
  localStorage.setItem(WIDTH_KEY, String(width));
  window.dispatchEvent(new Event(EVENT));
  emit();
}

function useNarrow() {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia("(max-width: 1023px)");
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia("(max-width: 1023px)").matches,
    () => false,
  );
}

export function InspectorDock({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const narrow = useNarrow();
  const dockWidth = useSyncExternalStore(subscribe, currentWidth, () => 420);

  useEffect(() => {
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
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (narrow) {
    return (
      <div role="dialog" aria-modal="true" aria-label="Incident inspection" className="fixed inset-0 z-40 flex flex-col bg-base-200">
        <DockHeader label={label} onClose={onClose} />
        <div id="incident-detail" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto focus:outline-none">
          {children}
        </div>
      </div>
    );
  }

  return (
    <section
      aria-label="Incident inspection"
      suppressHydrationWarning
      style={{ width: dockWidth }}
      className="relative flex h-full shrink-0 flex-col border-l border-base-300 bg-base-200"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={MIN}
        aria-valuemax={MAX}
        aria-valuenow={dockWidth}
        tabIndex={0}
        className={`absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize ${focusRing}`}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          const startX = event.clientX;
          const startWidth = dockWidth;
          const move = (pointer: PointerEvent) => setWidth(startWidth - (pointer.clientX - startX));
          const stop = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", stop);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", stop);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") setWidth(dockWidth + 16);
          if (event.key === "ArrowRight") setWidth(dockWidth - 16);
          if (event.key === "Home") setWidth(MIN);
          if (event.key === "End") setWidth(MAX);
        }}
      />
      <DockHeader label={label} onClose={onClose} />
      <div id="incident-detail" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto focus:outline-none">
        {children}
      </div>
    </section>
  );
}

function DockHeader({ label, onClose }: { label: string; onClose: () => void }) {
  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-base-300 px-3">
      <h2 className="min-w-0 truncate font-mono text-sm">{label}</h2>
      <button type="button" className={`inline-flex min-h-11 items-center rounded-md px-2 text-sm ${focusRing}`} onClick={onClose}>
        Close
      </button>
    </header>
  );
}
