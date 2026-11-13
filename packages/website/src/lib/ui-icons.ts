// Shared decorative line icons; names are internal, never supplied by URL input.
export const UI_ICONS = {
  app: "M3 3h18v18H3z M3 8h18 M9 8v13",
  memory: "m12 3 9 5-9 5-9-5 9-5 M3 12l9 5 9-5 M3 16l9 5 9-5",
  connect: "M8 3v5 M16 3v5 M5 8h14v3a7 7 0 0 1-14 0V8 M12 18v3",
  docs: "M12 5c-3-2-6-2-10-1v15c4-1 7-1 10 1 3-2 6-2 10-1V4c-4-1-7-1-10 1v15",
  notes: "M5 3h10l4 4v14H5V3 M14 3v5h5 M8 12h8 M8 16h5",
  help: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20 M9 8a3 3 0 0 1 6 0c0 2-3 2-3 5 M12 17h.01",
  chat: "M4 4h16v12H9l-5 4V4 M8 8h8 M8 12h5",
  bookmark: "M5 3h14v18l-7-4-7 4V3 M9 7h6",
  compass: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20 m4-14-2 6-6 2 2-6 6-2",
  history: "M3 4v5h5 M3 9a9 9 0 1 1 1 9 M12 7v5l3 2",
  activity: "M2 12h5l3-8 4 16 3-8h5",
  download: "M12 3v12 m-5-5 5 5 5-5 M4 16v5h16v-5",
  check: "m7 12 3 3 7-7 M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20",
  search: "M17 17l5 5 M19 10a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  code: "m8 6-6 6 6 6 m8-12 6 6-6 6 m-3-15-2 18",
  workflow: "M3 3h6v6H3V3 M15 15h6v6h-6v-6 M15 3h6v6h-6V3 M9 6h6 M6 9v9h9",
  settings: "M4 7h16 M4 17h16 M8 4v6 M16 14v6",
  people:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M17 3a4 4 0 0 1 0 8 M18 15a4 4 0 0 1 4 4v2",
} as const;
export type UiIconName = keyof typeof UI_ICONS;
