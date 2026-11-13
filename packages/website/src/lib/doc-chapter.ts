import type { UiIconName } from "./ui-icons";
export function docChapter(page: string): { label: string; icon: UiIconName } {
  if (/^guides\/with-(claude-code|codex|hermes|opencode|pi)\/$/.test(page))
    return { label: "Integrations", icon: "connect" };
  if (["", "install/", "first-session/", "troubleshooting/"].includes(page))
    return { label: "Get started", icon: "compass" };
  if (page === "review/") return { label: "Contributors", icon: "people" };
  if (
    page.startsWith("guides/") ||
    [
      "configuration/",
      "environment/",
      "architecture/",
      "installation-reference/",
      "setup/",
      "benchmark/",
    ].includes(page)
  )
    return { label: "Advanced & reference", icon: "settings" };
  return { label: "Use Lore", icon: "bookmark" };
}
