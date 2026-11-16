import type { MarkdownHeading } from "astro";

export interface ReferenceEntry {
  kind: "setting" | "group";
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
          .map(
            (h): ReferenceEntry => ({
              kind: "group",
              label: h.text.replaceAll("`", ""),
              slug: h.slug,
              group: "",
              description: "",
            }),
          );
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
    const isRootSetting = kind === "configuration" && field === section.label;
    const label =
      kind === "environment" ||
      isRootSetting ||
      field.startsWith(section.label + ".")
        ? field
        : section.label + "." + field;
    const cells = line.split(/(?<!\\)\|/).slice(1, -1);
    const defaultValue =
      kind === "configuration"
        ? literalCell(cells[2] ?? "")
        : plainDescription(
            /\*\*Default:\*\*\s*(.*)$/.exec(cells[0] ?? "")?.[1] ?? "",
          );
    const entry: ReferenceEntry = {
      kind: "setting",
      label,
      slug: isRootSetting ? section.slug : `setting-${label}`,
      group: isRootSetting ? "" : section.label,
      description: plainDescription(cells.at(-1) ?? ""),
      ...(kind === "configuration" && {
        type: literalCell(cells[1] ?? ""),
      }),
      ...(defaultValue && { defaultValue }),
    };
    if (isRootSetting) Object.assign(section, entry);
    settings.set(label, entry);
  }
  return { categories, settings: [...settings.values()] };
}

// Table escaping and Markdown code delimiters are not part of a schema literal.
function literalCell(value: string): string {
  return value.replaceAll("`", "").replaceAll("\\|", "|").trim();
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
