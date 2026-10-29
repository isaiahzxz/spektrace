import type { DriftTone, StatusCategory } from "@/lib/dashboard/incident-status";

const DRIFT_TONE: Record<DriftTone, string> = {
  mismatch: "text-error",
  neutral: "text-base-content",
  muted: "text-st-muted",
  failed: "text-error",
};

const STATUS_TONE: Record<StatusCategory, string> = {
  pending: "st-pending",
  triaged: "st-triaged",
  unsupported: "st-neutral",
  failed: "st-fail",
};

export function StatusBadge({
  category,
  label,
}: {
  category: StatusCategory;
  label: string;
}) {
  return (
    <span className={`st-chip ${STATUS_TONE[category]}`}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {label}
    </span>
  );
}

export function DriftText({ label, tone }: { label: string; tone: DriftTone }) {
  return <span className={`text-sm leading-snug ${DRIFT_TONE[tone]}`}>{label}</span>;
}

export function ViolationMark({ label }: { label: string }) {
  return <span className="st-chip st-fail">{label}</span>;
}

export function MethodMark({ method }: { method: string }) {
  return <span className="st-method st-neutral">{method}</span>;
}
