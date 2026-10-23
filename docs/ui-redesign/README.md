# UI workspace redesign

Screenshots use the disposable database seeded by the UI browser tests.

`mobile-navigation.png`, `mobile-account.png`, and `mobile-account-light.png`
show the current zinc foundation and green accents. The mobile account row is
fully tappable, its panel aligns with the drawer, and theme controls have 44px
touch targets. Regenerate with the mobile profile row case in
`folk-status.spec.ts` after building the gateway bundle.

Desktop retains the icon rail; below 768px, a logo-free toolbar button opens the
labeled sliding drawer and the document uses the full viewport width.

The reader and model-usage captures also show the current zinc palette. Section
labels and duplicate-review notice cards use neutral tokens; green remains on
links, primary actions, selected navigation, status accents, and passage highlights.
Regenerate reader captures with `workspace-shell.spec.ts` and model captures with
`model-usage.spec.ts`. The earlier overview capture documents layout work before
the zinc update and can be regenerated with `responsive-layout.spec.ts`.


The remaining-page audit covers 23 routes (including the not-found fallback),
entity and knowledge details, and the session reader at 1440, 390, and 320px
in both themes. Signed-in team forms and populated promotions/conflicts use
mocked account responses over the disposable gateway database.
`team-mobile-light.png` and `team-mobile-dark.png` show the organization and
invitation forms with green native checkbox accents. The content pane is
scrolled to the lower form section.
`gateway-connect-mobile-light.png` and `gateway-connect-mobile-dark.png` show
the standalone connection screen using the owned shadcn field and button.
Regenerate with `responsive-layout.spec.ts` and `folk03.spec.ts` against the
built gateway bundle. The connection screenshots are taken before entering
the synthetic token used to verify required validation and Enter submission.

`team-invite-mobile-dark.png` is the invitation card detail from the same run.
