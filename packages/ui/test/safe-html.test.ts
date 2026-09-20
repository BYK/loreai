/**
 * Sanitiser battery for the reader's one HTML boundary. Each case is a
 * payload an agent transcript could plausibly contain (or an attacker could
 * plant in a repository the agent reads) and asserts on the *DOM* that would
 * result, not on string matching alone.
 */
import { describe, expect, it } from "vitest";

import {
  HIGHLIGHT_LANGUAGES,
  MAX_MARKDOWN_CHARS,
  renderCode,
  renderMarkdown,
  renderPlain,
  resolveLanguage,
  stripBidiControls,
} from "~/lib/safe-html";
import { messageBlock } from "~/reader/blocks";
import {
  RENDER_CACHE_LIMIT,
  clearRenderCache,
  renderCacheSize,
  renderPart,
} from "~/reader/render";

function dom(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

function attrs(el: HTMLElement): string[] {
  const out: string[] = [];
  for (const node of el.querySelectorAll("*")) {
    for (const a of node.attributes)
      out.push(`${node.tagName.toLowerCase()}[${a.name}]`);
  }
  return out;
}

const HOSTILE = [
  "<script>alert(1)</script>",
  '<img src=x onerror="alert(1)">',
  "[click](javascript:alert(1))",
  "[click](JaVaScRiPt:alert(1))",
  "[click](javascript&colon;alert(1))",
  "[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
  "[click](vbscript:msgbox)",
  "![x](data:image/svg+xml;base64,PHN2Zy8+)",
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<a href="https://ok" onmouseover="alert(1)">x</a>',
  "<svg><script>alert(1)</script></svg>",
  '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
  "<style>body{display:none}</style>",
  '<form action="https://evil"><input name=x></form>',
  '<meta http-equiv="refresh" content="0;url=https://evil">',
  '<base href="https://evil/">',
  '<details open ontoggle="alert(1)">',
  '<object data="https://evil"></object>',
  '<embed src="https://evil">',
  '<link rel="stylesheet" href="https://evil/x.css">',
  '<a href="https://ok" target="_top">x</a>',
  "<div id=x tabindex=1 onfocus=alert(1) autofocus>",
  "```html\n<script>alert(1)</script>\n```",
  "```javascript\n</script><script>alert(1)</script>\n```",
  "<!--<img src=x onerror=alert(1)>-->",
  "&lt;script&gt;alert(1)&lt;/script&gt;",
  "<p><p><p><p><p><p>" + "<b>".repeat(500),
];

describe("renderMarkdown — hostile content", () => {
  it.each(HOSTILE)("neutralises %s", (payload) => {
    const { html } = renderMarkdown(payload);
    const el = dom(html);
    expect(
      el.querySelector(
        "script,iframe,img,svg,math,style,form,input,meta,base,object,embed,link,details",
      ),
    ).toBeNull();
    for (const a of attrs(el)) {
      expect(a).not.toMatch(/\[on[a-z]+\]/);
      expect(a).not.toMatch(
        /\[(?:src|srcdoc|action|style|id|tabindex|autofocus|formaction|xlink:href)\]/,
      );
    }
    for (const anchor of el.querySelectorAll("a[href]")) {
      const href = anchor.getAttribute("href") ?? "";
      expect(href).toMatch(/^(?:https?:|mailto:)/i);
      expect(anchor.getAttribute("rel")).toBe("noopener noreferrer");
      expect(anchor.getAttribute("target")).toBe("_blank");
    }
    // Raw HTML is shown as text, not lost silently.
    if (payload.startsWith("<script>"))
      expect(el.textContent).toContain("<script>");
  });

  it("keeps javascript: links as inert text", () => {
    const el = dom(renderMarkdown("[click](javascript:alert(1))").html);
    const a = el.querySelector("a");
    expect(a).not.toBeNull();
    expect(a?.hasAttribute("href")).toBe(false);
    expect(a?.textContent).toBe("click");
  });

  it("marks http(s) links external with the safe rel/target and drops others", () => {
    const el = dom(
      renderMarkdown(
        "[a](https://example.com/x?y=1) [b](http://example.com) [c](mailto:x@y.z) [d](/relative) [e](#frag) [f](ftp://x)",
      ).html,
    );
    const links = [...el.querySelectorAll("a")];
    expect(links).toHaveLength(6);
    const withHref = links.filter((l) => l.hasAttribute("href"));
    expect(withHref.map((l) => l.getAttribute("href"))).toEqual([
      "https://example.com/x?y=1",
      "http://example.com",
      "mailto:x@y.z",
    ]);
    for (const l of withHref) {
      expect(l.getAttribute("rel")).toBe("noopener noreferrer");
      expect(l.getAttribute("target")).toBe("_blank");
      expect(l.hasAttribute("data-external")).toBe(true);
    }
  });

  it("never emits an <img>; images become labelled text + link", () => {
    const el = dom(
      renderMarkdown("![alt text](https://example.com/a.png)").html,
    );
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("[image: alt text]");
    expect(el.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com/a.png",
    );
  });

  it("strips bidi override controls (RTL spoofing) and isolates direction in CSS", () => {
    const spoof = "run `rm \u202E txt.exe`";
    const { html, text } = renderMarkdown(spoof);
    expect(text).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
    expect(html).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
    expect(stripBidiControls("a\u2066b\u2069c\u202Ad")).toBe("abcd");
    // Ordinary RTL text is untouched.
    expect(renderMarkdown("שלום עולם").text).toBe("שלום עולם");
  });

  it("only keeps the classes this module emits", () => {
    const el = dom(renderMarkdown("```ts\nconst a: number = 1\n```").html);
    const classes = new Set<string>();
    for (const n of el.querySelectorAll("[class]")) {
      for (const c of n.classList) classes.add(c);
    }
    for (const c of classes) expect(c).toMatch(/^(?:hljs|hljs-|language-)/);
    expect(classes.has("hljs")).toBe(true);
  });

  it("keeps highlight.js sub-scope classes so `.hljs-title.function_` styles apply", () => {
    const el = dom(
      renderMarkdown("```ts\nfunction go() {}\nclass A {}\n```").html,
    );
    expect(el.querySelector(".hljs-title.function_")?.textContent).toBe("go");
    expect(el.querySelector(".hljs-title.class_")?.textContent).toBe("A");
    for (const n of el.querySelectorAll("[class]")) {
      for (const c of n.classList) {
        expect(c).toMatch(/^(?:hljs|hljs-[a-z_-]+|[a-z]+_|language-ts)$/);
      }
    }
  });

  it("falls back to plain text above the Markdown size cap, quickly", () => {
    const huge = "*".repeat(MAX_MARKDOWN_CHARS + 1);
    const t0 = performance.now();
    const res = renderMarkdown(huge);
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(res.plain).toBe(true);
    expect(res.text).toBe(huge);
    expect(dom(res.html).querySelector("pre")?.textContent).toBe(huge);
  });

  it("renders a large but legal block under the cap without stalling", () => {
    const big = Array.from(
      { length: 2_000 },
      (_, i) => `- item **${i}** with [link](https://e.com/${i})`,
    ).join("\n");
    expect(big.length).toBeLessThan(MAX_MARKDOWN_CHARS);
    const t0 = performance.now();
    const res = renderMarkdown(big);
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect(dom(res.html).querySelectorAll("li")).toHaveLength(2_000);
  });

  it("returns displayed text that matches the DOM textContent exactly", () => {
    const src =
      "# Title\n\nPara with `code` and **bold**.\n\n- a\n- b\n\n```js\nlet x = 1;\n```\n";
    const { html, text } = renderMarkdown(src);
    expect(dom(html).textContent).toBe(text);
  });

  it("never throws on odd input", () => {
    for (const src of [
      "",
      "\u0000",
      "\ud800",
      "[",
      "```",
      "|a|\n|-|",
      "<",
      "&",
      "\n".repeat(1000),
    ]) {
      expect(() => renderMarkdown(src)).not.toThrow();
    }
  });
});

describe("code highlighting", () => {
  it("highlights known grammars and aliases, escapes unknown ones", () => {
    expect(resolveLanguage("ts")).toBe("ts");
    expect(resolveLanguage("TypeScript")).toBe("typescript");
    expect(resolveLanguage("brainfuck")).toBeNull();
    expect(resolveLanguage("<script>")).toBeNull();
    expect(resolveLanguage(undefined)).toBeNull();
    expect(HIGHLIGHT_LANGUAGES).toContain("typescript");

    const ok = dom(renderCode("const a = '<b>'", "ts").html);
    expect(ok.querySelector("code.hljs")).not.toBeNull();
    expect(ok.querySelector("b")).toBeNull();
    expect(ok.textContent).toBe("const a = '<b>'");

    const unknown = dom(renderCode("<b>x</b>", "brainfuck").html);
    expect(unknown.querySelector("b")).toBeNull();
    expect(unknown.textContent).toBe("<b>x</b>");
  });

  it("does not let a fence info string inject attributes", () => {
    const el = dom(renderMarkdown('```ts" onmouseover="alert(1)\nx\n```').html);
    for (const a of attrs(el)) expect(a).not.toMatch(/\[on/);
  });
});

describe("renderPlain", () => {
  it("escapes everything and preserves the text", () => {
    const src = "<script>x</script> & \"q\" 'a'";
    const res = renderPlain(src);
    expect(dom(res.html).querySelector("script")).toBeNull();
    expect(dom(res.html).textContent).toBe(src);
    expect(res.text).toBe(src);
    expect(res.plain).toBe(true);
  });
});

describe("render cache", () => {
  const base = {
    id: "m1",
    source_id: null,
    project_id: "p",
    session_id: "s",
    role: "assistant",
    tokens: 0,
    distilled: 0,
    created_at: 1,
    metadata: "{}",
  };

  it("is keyed by block, part and revision", () => {
    clearRenderCache();
    const a = messageBlock({ ...base, content: "**a**" });
    const first = renderPart(a, a.parts[0]!);
    expect(renderPart(a, a.parts[0]!)).toBe(first);
    expect(renderCacheSize()).toBe(1);

    const edited = messageBlock({ ...base, content: "**b**" });
    expect(renderPart(edited, edited.parts[0]!)).not.toBe(first);
    expect(renderPart(edited, edited.parts[0]!).text).toBe("b");
    expect(renderCacheSize()).toBe(2);

    const other = messageBlock({ ...base, id: "m2", content: "**a**" });
    expect(renderPart(other, other.parts[0]!)).not.toBe(first);
    expect(renderCacheSize()).toBe(3);
  });

  it("is bounded and evicts the least recently used entry", () => {
    clearRenderCache();
    const blocks = Array.from({ length: RENDER_CACHE_LIMIT + 5 }, (_, i) =>
      messageBlock({ ...base, id: `b${i}`, content: `text ${i}` }),
    );
    const first = blocks[0]!;
    const second = blocks[1]!;
    const firstRender = renderPart(first, first.parts[0]!);
    const secondRender = renderPart(second, second.parts[0]!);
    for (const b of blocks.slice(2, RENDER_CACHE_LIMIT))
      renderPart(b, b.parts[0]!);
    // Touch the first entry so it becomes most-recent before the overflow.
    expect(renderPart(first, first.parts[0]!)).toBe(firstRender);
    for (const b of blocks.slice(RENDER_CACHE_LIMIT))
      renderPart(b, b.parts[0]!);
    expect(renderCacheSize()).toBe(RENDER_CACHE_LIMIT);
    expect(renderPart(first, first.parts[0]!)).toBe(firstRender);
    expect(renderPart(second, second.parts[0]!)).not.toBe(secondRender);
  });
});
