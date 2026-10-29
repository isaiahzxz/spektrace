# Dashboard sketch implementation

User direction: exact shell structure from hand sketch, monochrome palette and thin divided overview from second reference. Main navigation Overview, Integrations, Observations. Fixed labeled sidebar; announcements below main navigation; Help Center and Settings near bottom. Header page name, Overview-only welcome, Add integration, notification bell and profile. Overview uses actual scoped metrics, integration status, findings and captured calls. Editable operator announcements cover product updates and platform notices.

Antislop active during (session override). Preferred sources consulted: ReUI, 21st.dev, Spectrum UI, Kinetics, PanelUI. Use current React/Next/Tailwind and native dialog/details controls; no new component dependency needed. Reference fidelity takes precedence over generic layout defaults. No decorative animation. Retain light mode and accessible focus. No fabricated metrics or announcement content.

Plan: replace shell; add scoped overview; add guarded operator announcement store/editor and Help Center; verify types/lint/build, isolation and browser desktop/mobile interactions. Preserve existing observation processing and notification behavior, database migrations and private configuration. Announcements use an operator-owned JSON file on this single server; multi-server production needs shared persistent storage.

Completed: shell, actual scoped Overview, announcements/editor, Help Center, and browser review. Final verification fc56a112-2ade-4f3b-a395-e41a89723b93 passed; see docs/checkpoints/sketched-dashboard-2026-10-28.md.
