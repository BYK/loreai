import type { MarkdownHeading } from "astro";

export interface ReferenceEntry {
  label: string;
  slug: string;
  group: string;
}

/** Index authored field tables against rendered heading IDs, without deriving IDs. */
export function buildReferenceDirectory(
  body: string,
  headings: MarkdownHeading[],
  kind: "configuration" | "environment",
) {
  const root =
    kind === "configuration" ? "field-reference" : "setting-reference";
  const start = headings.findIndex((h) => h.slug === root);
  const categories =
    start < 0
      ? []
      : headings
          .slice(start + 1)
          .filter((h) => h.depth === 2 || h.depth === 3)
          .map((h) => ({
            label: h.text.replaceAll("`", ""),
            slug: h.slug,
            group: "",
          }));
  const settings = new Map(categories.map((entry) => [entry.label, entry]));
  let section: ReferenceEntry | undefined;
  let fence: string | undefined;
  for (const line of body.split("\n")) {
    const delimiter = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter) {
      if (!fence) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length)
        fence = undefined;
      continue;
    }
    if (fence) continue;
    const heading = /^#{2,3}\s+(.+)$/
      .exec(line)?.[1]
      .replaceAll("`", "")
      .trim();
    if (heading) section = categories.find((entry) => entry.label === heading);
    if (!section) continue;
    const field = /^\|\s*`([A-Za-z_][A-Za-z0-9_.]*)`[^|]*\|/.exec(line)?.[1];
    if (!field || (kind === "environment" && !/^[A-Z][A-Z0-9_]+$/.test(field)))
      continue;
    const label =
      kind === "environment" || field.startsWith(section.label + ".")
        ? field
        : section.label + "." + field;
    if (!settings.has(label))
      settings.set(label, { label, slug: section.slug, group: section.label });
  }
  return { categories, settings: [...settings.values()] };
}
