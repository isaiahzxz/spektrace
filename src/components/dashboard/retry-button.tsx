"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toolButton } from "@/components/dashboard/styles";

export function RetryButton({ onRetry }: { onRetry?: () => void }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <button
      type="button"
      aria-disabled={isPending}
      className={toolButton}
      onClick={() =>
        !isPending &&
        startTransition(() => {
          if (onRetry) {
            onRetry();
          } else {
            router.refresh();
          }
        })
      }
    >
      {isPending ? "Retrying…" : "Retry"}
    </button>
  );
}
