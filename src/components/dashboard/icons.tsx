import type { ReactNode } from "react";

/** One outline family, 24px view, 1.75 stroke. Drawn to match Tabler’s optical size. */
export function Icon({ children }: { children: ReactNode }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      {children}
    </svg>
  );
}

export function IconOverview() {
  return (
    <Icon>
      <rect x="4" y="4" width="6" height="6" rx="1" />
      <rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" />
      <rect x="14" y="14" width="6" height="6" rx="1" />
    </Icon>
  );
}

export function IconIncidents() {
  return (
    <Icon>
      <path d="M8 6h12M8 12h12M8 18h12" />
      <path d="M4 6h.01M4 12h.01M4 18h.01" />
    </Icon>
  );
}

export function IconPatterns() {
  return (
    <Icon>
      <path d="M4 19V5M4 19h16" />
      <path d="M7 15l4-5 3 3 5-7" />
    </Icon>
  );
}

export function IconSpecs() {
  return (
    <Icon>
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
    </Icon>
  );
}

export function IconAudit() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l2.5 2" />
    </Icon>
  );
}

export function IconSettings() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
    </Icon>
  );
}

export function IconEnvironment() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="8" />
      <path d="M4 12h16M12 4c2.2 2.4 3.3 5.1 3.3 8S14.2 17.6 12 20c-2.2-2.4-3.3-5.1-3.3-8S9.8 6.4 12 4z" />
    </Icon>
  );
}

export function IconViews() {
  return (
    <Icon>
      <path d="M6 4h9l3 3v13H6z" />
      <path d="M9 12h6M9 16h4" />
    </Icon>
  );
}

export function IconPin() {
  return (
    <Icon>
      <path d="M9 10V5h6v5l2 2v2h-4.2L12 20l-.8-6H7v-2z" />
    </Icon>
  );
}

export function IconIntegrations() {
  return (
    <Icon>
      <path d="M8 8V5a2 2 0 0 1 2-2h0a2 2 0 0 1 2 2v3" />
      <path d="M8 16v3a2 2 0 0 0 2 2h0a2 2 0 0 0 2-2v-3" />
      <path d="M4 12h4M16 12h4" />
      <rect x="8" y="8" width="8" height="8" rx="1" />
    </Icon>
  );
}

export function IconDocs() {
  return (
    <Icon>
      <path d="M7 4h8l3 3v13H7z" />
      <path d="M15 4v4h4" />
    </Icon>
  );
}

export function IconLogout() {
  return (
    <Icon>
      <path d="M14 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2" />
      <path d="M9 12h12m0 0-3-3m3 3-3 3" />
    </Icon>
  );
}

export function IconBell() {
  return (
    <Icon>
      <path d="M10 5a2 2 0 1 1 4 0 7 7 0 0 1 4 6v3l1.5 2H4.5L6 14v-3a7 7 0 0 1 4-6" />
      <path d="M9.5 18a2.5 2.5 0 0 0 5 0" />
    </Icon>
  );
}

export function IconCalendar() {
  return (
    <Icon>
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M8 3v4M16 3v4M4 10h16" />
    </Icon>
  );
}

export function IconCopy() {
  return (
    <Icon>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M6 16H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Icon>
  );
}

export function LogoMark() {
  return (
    <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-base-200 text-sm font-semibold text-base-content" aria-hidden="true">
      S
    </span>
  );
}
