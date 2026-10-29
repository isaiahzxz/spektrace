import { INVESTIGATION_GROUPING_WINDOW_MS } from "@/lib/investigation/config";

export type GroupingWindow = {
  /** Inclusive lower bound (UTC). */
  start: Date;
  /** Exclusive upper bound (UTC). */
  end: Date;
};

/**
 * Buckets incidents by server receipt time into non-overlapping 15-minute windows.
 * Window boundaries are aligned to UTC epoch multiples of the configured window size.
 */
export function groupingWindowForReceivedAt(receivedAt: Date): GroupingWindow {
  const startMs =
    Math.floor(receivedAt.getTime() / INVESTIGATION_GROUPING_WINDOW_MS) *
    INVESTIGATION_GROUPING_WINDOW_MS;
  return {
    start: new Date(startMs),
    end: new Date(startMs + INVESTIGATION_GROUPING_WINDOW_MS),
  };
}
