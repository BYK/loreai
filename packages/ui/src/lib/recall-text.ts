export type RecallNode =
  | { kind: "heading"; level: 2 | 3 | 4; text: string }
  | { kind: "item" | "paragraph"; text: string; linkId?: string }
  | { kind: "separator" };

function inline(
  text: string,
): { text: string; bold?: boolean; linkId?: string }[] {
  const parts: { text: string; bold?: boolean; linkId?: string }[] = [];
  const re = /\*\*([^*]+)\*\*|\(k:([^)]+)\)/g;
  let index = 0;
  for (const match of text.matchAll(re)) {
    const at = match.index ?? 0;
    if (at > index) parts.push({ text: text.slice(index, at) });
    if (match[1]) parts.push({ text: match[1], bold: true });
    else if (match[2])
      parts.push({ text: `(k:${match[2]})`, linkId: match[2] });
    index = at + match[0].length;
  }
  if (index < text.length) parts.push({ text: text.slice(index) });
  return parts.length ? parts : [{ text }];
}

export function parseRecallMarkdown(text: string): RecallNode[] {
  return text.split(/\r?\n/).flatMap((line): RecallNode[] => {
    if (!line.trim()) return [];
    if (line === "---") return [{ kind: "separator" }];
    const heading = line.match(/^(#{2,4}) (.*)$/);
    if (heading)
      return [
        {
          kind: "heading",
          level: heading[1]!.length as 2 | 3 | 4,
          text: heading[2]!,
        },
      ];
    const item = line.startsWith("- ");
    return [
      {
        kind: item ? "item" : "paragraph",
        text: line.replace(/^- /, ""),
        ...Object.fromEntries(
          inline(line.replace(/^- /, ""))
            .filter((p) => p.linkId)
            .map((p) => ["linkId", p.linkId]),
        ),
      },
    ];
  });
}

export function recallInline(text: string) {
  return inline(text);
}
