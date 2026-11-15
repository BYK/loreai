import mermaid from "mermaid";
import { setUtilityIcon } from "./utility-icon";

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
    expanded = wrap;
    canvas.append(svg);
    dialog.showModal();
  });
  return { target, source, wrap };
});
const dialog = document.createElement("dialog");
dialog.className = "diagram-dialog";
dialog.setAttribute("aria-label", "Expanded diagram");
const close = document.createElement("button");
close.type = "button";
close.className = "diagram-close ui-icon-button";
setUtilityIcon(close, "close", "Close diagram");
const canvas = document.createElement("div");
canvas.className = "diagram-canvas";
canvas.tabIndex = 0;
canvas.setAttribute("role", "region");
canvas.setAttribute("aria-label", "Diagram; scroll to explore");
const hint = document.createElement("p");
hint.className = "diagram-scroll-hint";
hint.textContent = "Scroll sideways to explore the full diagram.";
dialog.append(close, hint, canvas);
document.body.append(dialog);
let expanded: HTMLElement | undefined;
close.addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});
dialog.addEventListener("close", () => {
  const svg = canvas.querySelector("svg");
  if (svg && expanded) expanded.prepend(svg);
  expanded?.querySelector("button")?.focus({ preventScroll: true });
  expanded = undefined;
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
          if (expanded === record.wrap) canvas.replaceChildren(rendered);
          else {
            record.wrap.querySelector(":scope > svg")?.remove();
            record.wrap.prepend(rendered);
          }
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
