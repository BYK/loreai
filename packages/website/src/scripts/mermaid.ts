import mermaid from "mermaid";
import { setUtilityIcon } from "./utility-icon";
import { expandDiagram, refreshExpandedDiagram } from "./media-viewer";

// Sources are exclusively build-authored Markdown, never URL or user content.
// Preserve line boundaries from both Expressive Code and Shiki.
const records = [
  ...document.querySelectorAll<HTMLElement>('pre[data-language="mermaid"]'),
].map((pre) => {
  const lines = pre.querySelectorAll(".ec-line, .line");
  const source = lines.length
    ? [...lines].map((line) => line.textContent).join("\n")
    : ((pre.querySelector("code") ?? pre).textContent ?? "");
  const codeFrame = pre.closest(".frame");
  const target =
    codeFrame?.querySelectorAll("pre").length === 1 ? codeFrame : pre;
  const wrap = document.createElement("div");
  wrap.className = "mermaid";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "diagram-expand ui-icon-button";
  setUtilityIcon(button, "expand", "Expand diagram");
  wrap.append(button);
  button.addEventListener("click", () => {
    const svg = wrap.querySelector(":scope > svg");
    if (!svg) return;
    expandDiagram(wrap, button, svg as SVGSVGElement);
  });
  return { target, source, wrap };
});
const theme = () =>
  document.documentElement.dataset.theme === "dark" ? "dark" : "light";
let requested = theme();
let rendering = false;
async function renderAll() {
  if (rendering) return;
  rendering = true;
  try {
    let renderedTheme: string | undefined;
    while (renderedTheme !== requested) {
      const current = requested;
      mermaid.initialize({
        startOnLoad: false,
        theme: current === "dark" ? "dark" : "neutral",
        securityLevel: "loose",
        fontFamily: "system-ui, sans-serif",
      });
      for (const record of records) {
        if (!record.source.trim()) continue;
        try {
          const { svg } = await mermaid.render(
            "mermaid-" + crypto.randomUUID().replaceAll("-", ""),
            current === "dark"
              ? record.source.replace(/^([ \t]*classDef .*)$/gm, (line) =>
                  line
                    .replaceAll("fill:#ececec", "fill:#292a24")
                    .replaceAll("stroke:#888", "stroke:#a1a28f")
                    .replaceAll("color:#333", "color:#e9e9e2"),
                )
              : record.source,
          );
          if (current !== requested) break;
          const template = document.createElement("template");
          template.innerHTML = svg;
          const rendered = template.content.querySelector("svg");
          if (!rendered) continue;
          record.wrap.querySelector(":scope > svg")?.remove();
          record.wrap.prepend(rendered);
          refreshExpandedDiagram(record.wrap, rendered);
          if (record.target.isConnected) record.target.replaceWith(record.wrap);
          record.wrap.dataset.renderedTheme = current;
        } catch (error) {
          // Retain the original readable source or last successful SVG.
          console.error("Mermaid render failed:", error);
        }
      }
      renderedTheme = current;
    }
  } finally {
    rendering = false;
  }
}
new MutationObserver(() => {
  requested = theme();
  void renderAll();
}).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ["data-theme"],
});
void renderAll();
