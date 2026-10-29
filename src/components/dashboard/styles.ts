/** Theme accent: blue on parchment, periwinkle on the dark canvas. Both pass as focus rings. */
export const focusRing =
  "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-accent";

export const panel = "st-panel rounded-box border border-base-300 bg-base-200";

export const inset = "rounded-md border border-base-300 bg-st-code text-base-content";

export const sectionTitle = "font-sans text-sm font-medium tracking-tight text-base-content";

export const columnLabel = "font-mono text-xs font-medium tracking-normal text-st-muted";

export const panelPad = "p-4 sm:p-6";

/** Static label. No hover, so it does not look clickable. */
export const softBadge =
  "inline-flex items-center whitespace-nowrap rounded-md bg-base-300 px-2.5 py-1 text-xs text-base-content";

export const secondaryAction = `inline-flex min-h-11 items-center rounded-md bg-base-300/70 px-3 text-sm text-base-content transition-colors duration-150 hover:bg-base-300 ${focusRing}`;

export const primaryAction = `inline-flex min-h-11 items-center rounded-md bg-primary px-3 text-sm text-primary-content transition-colors duration-150 ${focusRing}`;

export const toolButton = secondaryAction;

export const navItem = `min-h-11 rounded-md transition-colors duration-150 ${focusRing}`;

export const navSelected = "bg-primary/10 font-medium text-accent";

export const rowHover = "st-row";

export const rowSelected = "st-selected";
