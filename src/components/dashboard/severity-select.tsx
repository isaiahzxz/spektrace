"use client";

import { useState } from "react";
import { focusRing } from "@/components/dashboard/styles";
import type { PatternSeverity } from "@/lib/dashboard/mismatch-patterns";
import { setPatternSeverity } from "@/server/dashboard/severity-action";

const OPTIONS: PatternSeverity[] = ["UNRATED", "LOW", "HIGH", "CRITICAL"];

export function SeveritySelect({
  patternKey,
  severity,
  provenance,
}: {
  patternKey: string;
  severity: PatternSeverity;
  provenance: "manual" | "unassigned";
}) {
  const [value, setValue] = useState(severity);
  const [note, setNote] = useState(provenance === "manual" ? "Human assignment" : "Unrated");
  const [pending, setPending] = useState(false);

  return (
    <div className="flex min-w-36 flex-col gap-1">
      <label className="sr-only" htmlFor={`severity-${patternKey}`}>
        Severity for {patternKey}
      </label>
      <select
        id={`severity-${patternKey}`}
        className={`min-h-11 rounded-md border border-base-300 bg-base-200 px-2 text-sm ${focusRing}`}
        value={value}
        disabled={pending}
        onChange={async (event) => {
          const next = event.target.value as PatternSeverity;
          setPending(true);
          const result = await setPatternSeverity(patternKey, next);
          setPending(false);
          if (result.ok) {
            setValue(next);
            setNote(next === "UNRATED" ? "Unrated" : "Human assignment");
          } else {
            setNote(result.detail);
          }
        }}
      >
        {OPTIONS.map((option) => (
          <option key={option} value={option}>
            {option === "UNRATED" ? "Unrated" : option[0] + option.slice(1).toLowerCase()}
          </option>
        ))}
      </select>
      <span className="text-xs text-st-muted">{pending ? "Saving" : note}</span>
    </div>
  );
}
