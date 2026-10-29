"use client";

import { useEffect, useRef } from "react";

/**
 * On stacked (narrow) layouts the inspection panel sits below the queue, so a new
 * selection would otherwise be off-screen. Wide layouts keep focus on the queue row.
 */
export function SelectionFocus({
  incidentId,
  targetId,
}: {
  incidentId: string | null;
  targetId: string;
}) {
  const previous = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const isFirstRender = previous.current === undefined;
    const changed = !isFirstRender && previous.current !== incidentId;
    previous.current = incidentId;
    if (!changed || !incidentId || window.matchMedia("(min-width: 1440px)").matches) {
      return;
    }

    const target = document.getElementById(targetId);
    if (!target) return;
    target.scrollIntoView({ block: "start" });
    target.focus({ preventScroll: true });
  }, [incidentId, targetId]);

  return null;
}
