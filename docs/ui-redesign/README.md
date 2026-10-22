# UI workspace redesign

Screenshots use the disposable database seeded by the UI browser tests.

`mobile-navigation.png`, `mobile-account.png`, and `mobile-account-light.png`
show the current zinc foundation and green accents. The mobile account row is
fully tappable, its panel aligns with the drawer, and theme controls have 44px
touch targets. Regenerate with the mobile profile row case in
`folk-status.spec.ts` after building the gateway bundle.

Desktop retains the icon rail; below 768px, a logo-free toolbar button opens the
labeled sliding drawer and the document uses the full viewport width.

Earlier reader, overview, and model-usage captures predate the zinc palette.
They document the layout work: collapsible context, full-width mobile readers,
aligned headings, contained tables, and usable narrow-screen forms/dialogs.
Regenerate reader captures with `workspace-shell.spec.ts`, overview captures
with `responsive-layout.spec.ts`, and model captures with `model-usage.spec.ts`.
