/**
 * The one browser-safe boundary between untrusted transcript text and the
 * DOM. Everything the session reader shows as rich content goes through
 * `renderMarkdown` / `renderPlain`; nothing else in the UI sets `innerHTML`.
 *
 * Pipeline: marked (GFM tokens → HTML, raw HTML *escaped*, images never
 * fetched) → highlight.js for fenced code in a registered grammar →
 * DOMPurify with an explicit tag/attribute allowlist → link policy hook
 * (`rel="noopener noreferrer"`, `target="_blank"`, `data-external` marker;
 * anything but http(s)/mailto loses its href). All three libraries run
 * without eval, so the gateway's CSP (`script-src 'self'`) is unchanged.
 *
 * The rendered HTML and its *displayed text* (the `textContent` of the
 * sanitised fragment) are returned together: source anchors index the
 * displayed text, so the two must always come from the same render.
 */
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { Marked, type Tokens } from "marked";

export interface RenderedHtml {
  /** Sanitised HTML, safe to assign to `innerHTML`. */
  html: string;
  /** `textContent` of `html` — the coordinate space of source anchors. */
  text: string;
  /** True when the source exceeded {@link MAX_MARKDOWN_CHARS} and was rendered as plain text. */
  plain: boolean;
}

/**
 * Above this many characters a text part is rendered as escaped plain text
 * instead of Markdown: a single pathological block must not stall the reader
 * in the Markdown tokenizer, and 200 KB of prose is not Markdown anyone
 * formatted by hand.
 */
export const MAX_MARKDOWN_CHARS = 200_000;

// ---------------------------------------------------------------------------
// highlight.js — core + a fixed grammar set (no auto-detection: it is slow
// and guesses wrong on transcripts).
// ---------------------------------------------------------------------------

// Grammar registration, the marked instance and the DOMPurify hooks are all
// created on first render rather than at import time: screens that never
// render a block (the project/knowledge browser) must not pay for the
// engines, and a side-effect-free module lets the bundler drop them.

const GRAMMARS: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
  bash,
  css,
  diff,
  go,
  javascript,
  json,
  markdown,
  python,
  rust,
  shell,
  sql,
  typescript,
  xml,
  yaml,
};
const ALIASES: Record<string, readonly string[]> = {
  javascript: ["js", "jsx", "mjs", "cjs"],
  typescript: ["ts", "tsx", "mts", "cts"],
  bash: ["sh", "zsh"],
  xml: ["html", "svg", "xhtml"],
  yaml: ["yml"],
  python: ["py"],
  rust: ["rs"],
  markdown: ["md"],
  shell: ["console", "shellsession"],
  diff: ["patch"],
};

let highlighter: typeof hljs | null = null;

function highlight(): typeof hljs {
  if (highlighter) return highlighter;
  for (const [name, grammar] of Object.entries(GRAMMARS)) {
    hljs.registerLanguage(name, grammar);
  }
  for (const [languageName, aliases] of Object.entries(ALIASES)) {
    hljs.registerAliases([...aliases], { languageName });
  }
  highlighter = hljs;
  return hljs;
}

export const HIGHLIGHT_LANGUAGES: readonly string[] = Object.freeze(
  Object.keys(GRAMMARS),
);

/** The grammar name a fence info string resolves to, or null when unknown. */
export function resolveLanguage(lang: string | undefined): string | null {
  if (!lang) return null;
  const name = lang.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  if (!name || !/^[a-z0-9+#._-]{1,32}$/.test(name)) return null;
  return highlight().getLanguage(name) ? name : null;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/** `<pre><code>` with highlight.js spans when `lang` is a known grammar. */
function codeBlockHtml(code: string, lang: string | undefined): string {
  const language = resolveLanguage(lang);
  const body = language
    ? highlight().highlight(code, { language, ignoreIllegals: true }).value
    : escapeHtml(code);
  const cls = language ? ` class="hljs language-${language}"` : "";
  return `<pre><code${cls}>${body}</code></pre>\n`;
}

// ---------------------------------------------------------------------------
// marked — GFM, raw HTML escaped, images rendered as text, checkboxes as text
// ---------------------------------------------------------------------------

let markedInstance: Marked | null = null;

function marked(): Marked {
  markedInstance ??= new Marked({
    gfm: true,
    breaks: false,
    async: false,
    renderer: {
      code({ text, lang }: Tokens.Code): string {
        return codeBlockHtml(text, lang);
      },
      html({ text }: Tokens.HTML | Tokens.Tag): string {
        // Raw HTML in a transcript is shown as the text the agent wrote, not
        // interpreted. (DOMPurify would strip it anyway; escaping keeps it
        // visible and honest.)
        return escapeHtml(text);
      },
      image({ href, text, title }: Tokens.Image): string {
        // Never fetch remote images (tracking pixels, IP leaks). Render the
        // alt text and the target as an ordinary link.
        const label = text || title || "image";
        return `<span class="md-image">[image: ${escapeHtml(label)}]${
          href ? ` <a href="${escapeHtml(href)}">${escapeHtml(href)}</a>` : ""
        }</span>`;
      },
      checkbox({ checked }: Tokens.Checkbox): string {
        return `<span class="md-checkbox">${checked ? "☑" : "☐"}</span> `;
      },
    },
  });
  return markedInstance;
}

// ---------------------------------------------------------------------------
// DOMPurify — explicit allowlist + link policy
// ---------------------------------------------------------------------------

const ALLOWED_TAGS = [
  "p",
  "br",
  "hr",
  "strong",
  "em",
  "del",
  "code",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "a",
  "span",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
];

const ALLOWED_ATTR = ["href", "title", "class", "start", "align"];

/** Only http(s) and mailto links keep their href; everything else is text. */
const SAFE_HREF = /^(?:https?:|mailto:)/i;

// Passed to every `sanitize` call (never `setConfig`, which would silently
// override per-call options).
const PURIFY_CONFIG = Object.freeze({
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  KEEP_CONTENT: true,
  RETURN_DOM_FRAGMENT: true as const,
});

let purifyInstance: ReturnType<typeof DOMPurify> | null = null;

function purify(): ReturnType<typeof DOMPurify> {
  if (purifyInstance) return purifyInstance;
  const instance = DOMPurify();
  instance.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName !== "A") return;
    const href = node.getAttribute("href")?.trim() ?? "";
    if (!SAFE_HREF.test(href)) {
      node.removeAttribute("href");
      node.removeAttribute("title");
      return;
    }
    node.setAttribute("href", href);
    node.setAttribute("rel", "noopener noreferrer");
    node.setAttribute("target", "_blank");
    node.setAttribute("data-external", "");
  });
  // The only `class` values that may survive are the ones this module emits:
  // highlight.js token classes (`hljs-title` plus a sub-scope such as
  // `function_` / `class_`) and the two Markdown markers above.
  instance.addHook("uponSanitizeAttribute", (_node, event) => {
    if (event.attrName !== "class") return;
    const classes = event.attrValue
      .split(/\s+/)
      .filter((c) =>
        /^(?:hljs|hljs-[a-z_-]+|[a-z]+_|language-[a-z0-9+#._-]+|md-image|md-checkbox)$/.test(
          c,
        ),
      );
    if (classes.length === 0) {
      event.keepAttr = false;
      return;
    }
    event.attrValue = classes.join(" ");
  });
  purifyInstance = instance;
  return instance;
}

/**
 * Bidi override/embedding controls (U+202A–U+202E, U+2066–U+2069) can make
 * a link or command read backwards from what it does. They are stripped
 * before parsing; ordinary RTL text needs none of them (the bidi algorithm
 * handles direction) and the containers render with `unicode-bidi: isolate`.
 */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;

export function stripBidiControls(text: string): string {
  return text.replace(BIDI_CONTROLS, "");
}

function sanitizeToFragment(dirty: string): DocumentFragment {
  return purify().sanitize(dirty, PURIFY_CONFIG);
}

/**
 * Drop the whitespace-only text nodes marked emits between top-level blocks
 * (`<p>…</p>\n<p>…</p>`). They carry no content, and removing them from the
 * fragment — not just from the returned string — keeps `text` identical to
 * the mounted DOM's `textContent`, which anchors depend on.
 */
function dropInterBlockWhitespace(fragment: DocumentFragment): void {
  const blank: ChildNode[] = [];
  for (const node of fragment.childNodes) {
    if (node.nodeType === Node.TEXT_NODE && !/\S/.test(node.nodeValue ?? "")) {
      blank.push(node);
    }
  }
  for (const node of blank) fragment.removeChild(node);
}

function serialize(fragment: DocumentFragment): RenderedHtml {
  dropInterBlockWhitespace(fragment);
  const holder = document.createElement("div");
  holder.appendChild(fragment);
  return {
    html: holder.innerHTML,
    text: holder.textContent ?? "",
    plain: false,
  };
}

/** Escaped plain text in a `<pre>`; used for tool output and oversized parts. */
export function renderPlain(source: string): RenderedHtml {
  const text = stripBidiControls(source);
  return {
    html: `<pre class="plain">${escapeHtml(text)}</pre>`,
    text,
    plain: true,
  };
}

/** GFM Markdown → sanitised HTML + displayed text. Never throws on input. */
export function renderMarkdown(source: string): RenderedHtml {
  const text = stripBidiControls(source);
  if (text.length > MAX_MARKDOWN_CHARS) return renderPlain(text);
  let dirty: string;
  try {
    dirty = marked().parse(text, { async: false });
  } catch {
    return renderPlain(text);
  }
  return serialize(sanitizeToFragment(dirty));
}

/** One fenced code block (used for parts that are known to be code). */
export function renderCode(source: string, lang?: string): RenderedHtml {
  const text = stripBidiControls(source);
  if (text.length > MAX_MARKDOWN_CHARS) return renderPlain(text);
  return serialize(sanitizeToFragment(codeBlockHtml(text, lang)));
}
