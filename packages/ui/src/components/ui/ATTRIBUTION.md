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
`badge.tsx`, `separator.tsx`. Kobalte (`@kobalte/core`) supplies the headless
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

Keep this file up to date when copying further components.
