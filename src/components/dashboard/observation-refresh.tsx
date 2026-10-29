"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { secondaryAction } from "./styles";
export function ObservationRefresh() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      className={secondaryAction}
      disabled={pending}
      onClick={() => start(() => router.refresh())}
    >
      {pending ? "Refreshing…" : "Refresh"}
    </button>
  );
}
