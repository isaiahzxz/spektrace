const NO_PINNED_SPEC = "__no_pinned_spec__";

export function pinnedApiSpecKey(apiSpecId: string | null | undefined): string {
  return apiSpecId ?? NO_PINNED_SPEC;
}
