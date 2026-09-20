import { Marked, type Token, type Tokens } from "marked";

export type RecallNode =
  | { kind: "heading"; level: 2 | 3 | 4; text: string }
  | { kind: "item" | "paragraph"; text: string; parts: InlinePart[] }
  | { kind: "separator" };

export type InlinePart = { text: string; bold?: boolean; linkId?: string };

type LoreLinkToken = Tokens.Generic & {
  type: "loreLink";
  id: string;
};

const marked = new Marked({
  extensions: [
    {
      name: "loreLink",
      level: "inline",
      start(source: string) {
        const index = source.indexOf("(k:");
        return index >= 0 ? index : undefined;
      },
      tokenizer(source: string) {
        const match = source.match(/^\(k:([^)]+)\)/);
        if (!match) return;
        return {
          type: "loreLink",
          raw: match[0],
          id: match[1],
        };
      },
    },
  ],
});

function textPart(text: string, bold = false): InlinePart {
  return bold ? { text, bold: true } : { text };
}

function inlineTokens(tokens: Token[], bold = false): InlinePart[] {
  const parts: InlinePart[] = [];
  for (const token of tokens) {
    if (token.type === "strong") {
      parts.push(...inlineTokens(token.tokens ?? [], true));
    } else if (token.type === "text") {
      if (token.tokens) {
        parts.push(...inlineTokens(token.tokens, bold));
      } else if (token.text) {
        parts.push(textPart(token.text, bold));
      }
    } else if (token.type === "loreLink") {
      const link = token as LoreLinkToken;
      parts.push({
        text: link.raw,
        linkId: link.id,
        ...(bold ? { bold: true } : {}),
      });
    } else if (token.type === "codespan" || token.type === "code") {
      parts.push(textPart(token.text, bold));
    } else if ("text" in token && typeof token.text === "string") {
      parts.push(textPart(token.text, bold));
    } else if (token.raw) {
      parts.push(textPart(token.raw, bold));
    }
  }
  return parts.length ? parts : [{ text: "" }];
}

function inline(text: string): InlinePart[] {
  return inlineTokens(
    marked
      .lexer(text)
      .flatMap((token) =>
        token.type === "paragraph" ? (token.tokens ?? []) : [token],
      ),
  );
}

function contentNode(
  kind: "item" | "paragraph",
  text: string,
  tokens?: Token[],
): RecallNode {
  return {
    kind,
    text,
    parts: tokens ? inlineTokens(tokens) : inline(text),
  };
}

function listItemTokens(item: Tokens.ListItem): Token[] {
  return item.tokens.filter((child) => child.type !== "list");
}

function listItemText(item: Tokens.ListItem): string {
  return listItemTokens(item)
    .map((token) =>
      "text" in token && typeof token.text === "string"
        ? token.text
        : token.raw,
    )
    .join("")
    .trim();
}

function nodesFromToken(token: Token): RecallNode[] {
  if (token.type === "heading") {
    return [
      {
        kind: "heading",
        level: Math.max(2, Math.min(4, token.depth)) as 2 | 3 | 4,
        text: token.text,
      },
    ];
  }
  if (token.type === "hr") return [{ kind: "separator" }];
  if (token.type === "paragraph") {
    return [contentNode("paragraph", token.text, token.tokens)];
  }
  if (token.type === "list") {
    return token.items.flatMap((item: Tokens.ListItem) => [
      contentNode("item", listItemText(item), listItemTokens(item)),
      ...(item.tokens ?? []).flatMap((child: Token) =>
        child.type === "list" ? nodesFromToken(child) : [],
      ),
    ]);
  }
  if (
    token.type === "code" ||
    token.type === "html" ||
    token.type === "blockquote" ||
    token.type === "table"
  ) {
    const text =
      "text" in token && typeof token.text === "string" ? token.text : "";
    return text ? [contentNode("paragraph", text)] : [];
  }
  if (token.type === "space") return [];
  if ("text" in token && typeof token.text === "string" && token.text) {
    return [contentNode("paragraph", token.text)];
  }
  return [];
}

export function parseRecallMarkdown(text: string): RecallNode[] {
  return marked.lexer(text).flatMap(nodesFromToken);
}

export function recallInline(text: string) {
  return inline(text);
}
