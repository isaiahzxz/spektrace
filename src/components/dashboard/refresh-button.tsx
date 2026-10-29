"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { focusRing } from "@/components/dashboard/styles";

export function RefreshButton() {
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <button
      type="button"
      className={`inline-flex min-h-11 items-center rounded-md bg-base-300/70 px-3 text-sm transition-colors duration-150 hover:bg-base-300 disabled:cursor-not-allowed disabled:opacity-60 ${focusRing}`}
      disabled={pending}
      onClick={() => start(() => router.refresh())}
    >
      {pending ? "Refreshing" : "Refresh"}
    </button>
  );
}
