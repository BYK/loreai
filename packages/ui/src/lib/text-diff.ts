import { diffArrays } from "diff";

export interface TextChange {
  kind: "equal" | "added" | "removed";
  text: string;
}

/** Word diff with exact whitespace preservation and bounded input/work.
 * Oversized historical/imported entries fall back to their full text. */
export function diffText(before: string, after: string): TextChange[] | null {
  if (before === after) return before ? [{ kind: "equal", text: before }] : [];
  if (before.length + after.length > 20_000) return null;
  const tokenize = (text: string) =>
    text.match(/\s+|[\p{L}\p{M}\p{N}_]+|[^\s\p{L}\p{M}\p{N}_]/gu) ?? [];
  const a = tokenize(before);
  const b = tokenize(after);
  // Retain the original token-pair budget even without an LCS matrix.
  if ((a.length + 1) * (b.length + 1) > 250_000) return null;
  const changes = diffArrays(a, b, { timeout: 25, maxEditLength: 1000 });
  return (
    changes?.map<TextChange>((part) => ({
      kind: part.added ? "added" : part.removed ? "removed" : "equal",
      text: part.value.join(""),
    })) ?? null
  );
}
