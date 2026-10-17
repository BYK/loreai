export interface TextChange {
  kind: "equal" | "added" | "removed";
  text: string;
}

/** Word diff with exact whitespace preservation and a bounded LCS matrix.
 * Oversized historical/imported entries fall back to their full text. */
export function diffText(before: string, after: string): TextChange[] | null {
  if (before === after) return before ? [{ kind: "equal", text: before }] : [];
  if (before.length + after.length > 20_000) return null;
  const tokenize = (text: string) =>
    text.match(/\s+|[\p{L}\p{M}\p{N}_]+|[^\s\p{L}\p{M}\p{N}_]/gu) ?? [];
  const a = tokenize(before);
  const b = tokenize(after);
  const width = b.length + 1;
  if ((a.length + 1) * width > 250_000) return null;
  const scores = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      scores[i * width + j] =
        a[i] === b[j]
          ? scores[(i + 1) * width + j + 1]! + 1
          : Math.max(scores[(i + 1) * width + j]!, scores[i * width + j + 1]!);
    }
  }
  const result: TextChange[] = [];
  const append = (kind: TextChange["kind"], text: string) => {
    const last = result.at(-1);
    if (last?.kind === kind) last.text += text;
    else result.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      append("equal", a[i++]!);
      j++;
    } else if (
      i < a.length &&
      (j === b.length ||
        scores[(i + 1) * width + j]! >= scores[i * width + j + 1]!)
    ) {
      append("removed", a[i++]!);
    } else {
      append("added", b[j++]!);
    }
  }
  return result;
}
