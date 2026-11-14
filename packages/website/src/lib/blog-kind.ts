import type { UiIconName } from "./ui-icons";
export const BLOG_KIND_ICONS = {
  "Product note": "notes",
  Engineering: "code",
  Perspective: "compass",
  Tutorial: "settings",
} as const satisfies Record<string, UiIconName>;
