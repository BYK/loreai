# UI workspace redesign

Screenshots use the disposable database seeded by the UI browser tests.

- Desktop keeps the icon rail and a separately collapsible context list.
- Below 768px, the document uses the full viewport width. A logo-free toolbar
  menu button opens labeled navigation in a sliding drawer, with account and
  appearance controls in its footer.
- Project overview/search fields, long titles, team forms, import tables, and
  dialogs wrap or scroll within their own containers on narrow screens.

Regenerate `reader-desktop.png` and `reader-mobile.png` with
`workspace-shell.spec.ts`, `mobile-navigation.png` with
`mobile-navigation.spec.ts`, and `overview-mobile.png` with
`responsive-layout.spec.ts` after building the gateway bundle.

`account-menu.png` comes from `folk-status.spec.ts`; model-usage desktop and
mobile captures come from `model-usage.spec.ts`.
