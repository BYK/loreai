import type { MarkdownHeading } from "astro";

export interface ReferenceEntry {
  label: string;
  slug: string;
  group: string;
  description: string;
  type?: string;
  defaultValue?: string;
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
          .filter(
            (h) =>
              (h.depth === 2 || h.depth === 3) &&
              !h.slug.startsWith("field-heading-"),
          )
          .map((h) => ({
            label: h.text.replaceAll("`", ""),
            slug: h.slug,
            group: "",
            description: "",
          }));
  const settings = new Map<string, ReferenceEntry>(
    categories.map((entry) => [entry.label, entry]),
  );
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
    if (!field && !section.description && /^[A-Za-z]/.test(line.trim()))
      section.description = plainDescription(line);
    if (!field || (kind === "environment" && !/^[A-Z][A-Z0-9_]+$/.test(field)))
      continue;
    const label =
      kind === "environment" || field.startsWith(section.label + ".")
        ? field
        : section.label + "." + field;
    const cells = line.split(/(?<!\\)\|/).slice(1, -1);
    const defaultValue =
      kind === "configuration"
        ? plainDescription(cells[2] ?? "")
        : plainDescription(
            /\*\*Default:\*\*\s*(.*)$/.exec(cells[0] ?? "")?.[1] ?? "",
          );
    settings.set(label, {
      label,
      slug: `setting-${label}`,
      group: section.label,
      description: plainDescription(line.split(/(?<!\\)\|/).at(-2) ?? ""),
      ...(kind === "configuration" && {
        type: plainDescription(cells[1] ?? ""),
      }),
      ...(defaultValue && { defaultValue }),
    });
  }
  return { categories, settings: [...settings.values()] };
}

/** Rendered as escaped text by Astro, never used as HTML or a selector. */
function plainDescription(value: string): string {
  const plain = value
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/`|\*\*|\*/g, "")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\\\|/g, "|")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > 180
    ? plain.slice(0, 177).replace(/\s+\S*$/, "") + "…"
    : plain;
}
