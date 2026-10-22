# Copied UI primitives

The files in this directory are **owned source**, copied from
[Solid UI](https://www.solid-ui.com) (stefan-karger/solid-ui, upstream commit
`21ba4fa59b775a8bf9ee8249883de34aba1cf807`, `apps/docs/src/registry/ui/*.tsx`),
which is itself a port of [shadcn/ui](https://ui.shadcn.com). Both are MIT
licensed:

```
MIT License

Copyright (c) 2023 shadcn
Copyright (c) 2023 Stefan E-K
```

Copied files: `button.tsx`, `dialog.tsx`, `select.tsx`, `text-field.tsx`,
`badge.tsx`, `separator.tsx`, `tabs.tsx`, `toggle-group.tsx`. The toggle group combines
upstream `toggle-group.tsx` with the `toggleVariants` styles from `toggle.tsx`;
the standalone toggle button recipe is not included.
Kobalte (`@kobalte/core`) supplies the headless
behaviour; the copied files only add class strings.

## Local modifications (Tailwind 4 port)

Solid UI's published recipe targets Tailwind 3 (`tailwind.config.js`,
`tailwindcss-animate`, `hsl(var(--x))` colours). Lore uses Tailwind 4 with the
`@tailwindcss/vite` plugin and CSS-first configuration, so the copies were
edited as follows (see `src/styles/app.css` for the token mapping):

- Colour utilities resolve through `@theme inline` to Lore's CSS custom
  properties; `bg-accent`/`text-accent-foreground` hover fills were renamed
  to `bg-soft`/`text-text` because `accent` is Lore's brand colour.
- Tailwind 4 renames applied: `focus-visible:outline-none` →
  `focus-visible:outline-hidden`, `outline-none` → `outline-hidden`,
  `shadow-sm` → `shadow-xs`, `ring-offset-*` kept (still valid).
- `tailwindcss-animate` classes (`animate-in`, `fade-in-0`, `zoom-in-95`,
  `slide-in-from-*`) were removed; no animation dependency is bundled.
- Double quotes / semicolons per the repository's oxfmt configuration.
- Toggle group pressed items use Lore's `bg-chrome`/`text-text`, and inactive
  items use `text-muted` with `bg-soft`/`text-text` hover styles.

- Dialogs use viewport insets, wrapping descriptions, and gaps between stacked
  footer actions so they remain usable on narrow screens.

Keep this file up to date when copying further components.

## Locally authored primitives

`popover.tsx` follows the owned Solid UI/shadcn component pattern and wraps
Kobalte's accessible popover. It is locally authored and uses Lore's existing
Tailwind 4 semantic tokens.

`resizable.tsx` is a locally authored Solid UI/shadcn-style resize handle using
native pointer and keyboard input, with no additional dependency.

`tooltip.tsx` is locally authored in the Solid UI/shadcn style and wraps Kobalte's accessible tooltip, using existing semantic colors and no new dependency.
