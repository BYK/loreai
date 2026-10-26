import type { Component } from "solid-js";

const paths = {
  copy: "M9 9h12v12H9z M15 9V3H3v12h6",
  link: "m10 13 4-4 M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0 M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0",
  save: "M3 3h15l3 3v15H3z M7 3v6h10V3 M7 21v-8h10v8",
  refresh: "M20 7v5h-5 M4 17v-5h5 M6 6a8 8 0 0 1 14 6 M18 18a8 8 0 0 1-14-6",
  loading: "M21 12a9 9 0 1 1-9-9",
  lock: "M5 10h14v11H5z M8 10V6a4 4 0 0 1 8 0v4 M12 14v3",
  empty: "M4 5h16v15H4z M4 13h5l1 3h4l1-3h5",
  up: "M12 20V4 m-6 6 6-6 6 6",
  down: "M12 4v16 m-6-6 6 6 6-6",
  filter: "M4 7h16 M7 12h10 M10 17h4",
  sort: "M8 4v16 m-3-3 3 3 3-3 M16 20V4 m-3 3 3-3 3 3",
  close: "m6 6 12 12 M6 18 18 6",
  monitor: "M3 4h18v13H3z M12 17v4 M8 21h8",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.5 1.5 M17.5 17.5 19 19 M5 19l1.5-1.5 M17.5 6.5 19 5",
  moon: "M20.5 13a9 9 0 0 1-9.5-9.5A9 9 0 1 0 20.5 13",

  user: "M20 21v-2a7 7 0 0 0-14 0v2 M13 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8",
  warning: "m12 3 10 18H2z M12 9v5 M12 17h.01",
  promote: "M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16 M12 16V8 m-3 3 3-3 3 3",
  nodes: "M4 4h5v5H4z M15 15h5v5h-5z M4 15h5v5H4z M9 6h8v9 M6 9v6",

  more: "M4 12h.01 M12 12h.01 M20 12h.01",
  reader: "M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5",
  panel: "M3 4h18v16H3z M9 4v16",
  folder: "M3 7V5h7l2 2h9v13H3z",
  book: "M4 3h13a3 3 0 0 1 3 3v15H7a3 3 0 0 1-3-3z M4 17h16 M8 7h8 M8 11h6",
  grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  messages: "M4 4h16v12H9l-5 4z M8 8h8 M8 12h5",
  layers: "m12 3 10 5-10 5L2 8z M2 12l10 5 10-5 M2 16l10 5 10-5",
  conflict:
    "M7 3v12a4 4 0 0 0 4 4h6 M4 6l3-3 3 3 M14 16l3 3-3 3 M17 3v5a4 4 0 0 1-4 4H7",
  users:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M17 4a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-4",
  activity: "M2 12h4l3-8 6 16 3-8h4",
  cost: "M12 2v20 M17 5H9a4 4 0 0 0 0 8h6a4 4 0 0 1 0 8H6",
  chart: "M3 3v18h18 M7 16v-4 M12 16V7 M17 16v-7",
  search: "M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  chevrons: "m8 9 4-4 4 4 M8 15l4 4 4-4",
  chevron: "m9 5 7 7-7 7",
  first: "m11 17-5-5 5-5 M18 17l-5-5 5-5",
  check: "m5 12 4 4L19 6",
  star: "m12 3 3 6 6 1-4.5 4.5 1 6.5-5.5-3-5.5 3 1-6.5L3 10l6-1z",
  settings:
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z",
  menu: "M4 6h16 M4 12h16 M4 18h16",
  arrow: "m12 5-7 7 7 7 M5 12h14",
  upload: "M12 16V3 M7 8l5-5 5 5 M4 14v7h16v-7",
} satisfies Record<string, string>;

export type IconName = keyof typeof paths;

export const Icon: Component<{ name: IconName; class?: string }> = (props) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.65"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class={`size-4 shrink-0 ${props.class ?? ""}`}
  >
    <path d={paths[props.name]} />
  </svg>
);
