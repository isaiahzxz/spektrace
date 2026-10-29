"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type LiveState = "active" | "paused" | "holding" | "recovering";

export function LiveRefresh() {
  const router = useRouter();
  const [state, setState] = useState<LiveState>("active");

  useEffect(() => {
    let running = false;
    let timer = 0;

    const tick = async () => {
      const focused = document.activeElement;
      const editing =
        focused instanceof HTMLTextAreaElement ||
        focused instanceof HTMLInputElement ||
        focused instanceof HTMLSelectElement;
      if (document.hidden || editing) {
        setState(document.hidden ? "paused" : "holding");
        return;
      }
      if (running) return;
      running = true;
      try {
        const response = await fetch("/api/dashboard/pulse", { cache: "no-store" });
        if (!response.ok) {
          setState("recovering");
          return;
        }
        setState("active");
        router.refresh();
      } catch {
        setState("recovering");
      } finally {
        window.setTimeout(() => {
          running = false;
        }, 1000);
      }
    };

    const onVisibility = () => setState(document.hidden ? "paused" : "active");
    document.addEventListener("visibilitychange", onVisibility);
    timer = window.setInterval(() => {
      void tick();
    }, 4000);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [router]);

  const label =
    state === "paused"
      ? "paused"
      : state === "holding"
        ? "paused while you edit"
        : state === "recovering"
          ? "could not reach the server. Retrying."
          : "every 4 seconds";

  return (
    <p className="text-xs text-st-muted" role="status">
      Updates {label}
    </p>
  );
}
