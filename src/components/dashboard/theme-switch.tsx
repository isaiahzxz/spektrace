"use client";

import { useSyncExternalStore } from "react";
import { focusRing } from "@/components/dashboard/styles";
import { THEME_STORAGE_KEY, themeAttribute, type ThemeChoice } from "@/lib/theme";

const THEME_EVENT = "spektrace-theme-change";

function currentTheme(): ThemeChoice {
  return document.documentElement.getAttribute("data-theme") === "spektrace" ? "light" : "dark";
}

function subscribe(onChange: () => void) {
  window.addEventListener(THEME_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(THEME_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function ThemeSwitch() {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => "dark" as const);

  const choose = (next: ThemeChoice) => {
    document.documentElement.setAttribute("data-theme", themeAttribute(next));
    localStorage.setItem(THEME_STORAGE_KEY, next);
    window.dispatchEvent(new Event(THEME_EVENT));
  };

  return (
    <div role="group" aria-label="Color theme" className="grid grid-cols-2 gap-1 rounded-md bg-base-300/70 p-1">
      {(["light", "dark"] as const).map((choice) => {
        const selected = theme === choice;
        return (
          <button
            key={choice}
            type="button"
            aria-pressed={selected}
            suppressHydrationWarning
            onClick={() => choose(choice)}
            className={`min-h-11 rounded px-2 text-sm transition-colors duration-150 ${focusRing} ${
              selected ? "bg-base-200 text-base-content" : "text-st-muted hover:text-base-content"
            }`}
          >
            {choice === "light" ? "Light" : "Dark"}
          </button>
        );
      })}
    </div>
  );
}
