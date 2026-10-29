"use client";

import { useState } from "react";
import { focusRing } from "@/components/dashboard/styles";
import { activateImportedRevision } from "@/server/dashboard/spec-activation";

export function ActivateRevisionForm({
  revisionId,
  label,
}: {
  revisionId: string;
  label: string;
}) {
  const [message, setMessage] = useState<string | null>(null);
  return (
    <form
      className="mt-3 flex flex-col gap-2"
      action={async (formData) => {
        const result = await activateImportedRevision(formData);
        setMessage(result.error ?? "Activation recorded.");
      }}
    >
      <input type="hidden" name="revisionId" value={revisionId} />
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="confirm" value="activate" className="mt-1" />
        <span>Activate {label}. This does not rewrite incidents already pinned to another revision.</span>
      </label>
      <button type="submit" className={`inline-flex min-h-11 w-fit items-center rounded-md border border-base-300 px-3 text-sm ${focusRing}`}>
        Activate imported revision
      </button>
      {message ? <p className="text-sm">{message}</p> : null}
    </form>
  );
}
