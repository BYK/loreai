// Mermaid renderer integration.
//
// Replaces the previous CDN-loaded script in starlight's head config. The
// renderer is bundled with the site via `injectScript`, so it runs on every
// page (Starlight docs AND the blog) without a network dependency. The
// render target is the same as the previous CDN script: any
// `pre[data-language="mermaid"]` block (Expressive Code's wrapping of a
// Mermaid fenced code block) is replaced with the rendered SVG.
export default function mermaidRenderer() {
  return {
    name: "mermaid-renderer",
    hooks: {
      "astro:config:setup": ({ injectScript }) => {
        injectScript(
          "page",
          `
          import mermaid from "mermaid";
          mermaid.initialize({
            startOnLoad: false,
            theme: "neutral",
            securityLevel: "loose",
            fontFamily: "var(--sl-font)"
          });
          const blocks = document.querySelectorAll('pre[data-language="mermaid"]');
          for (const pre of blocks) {
            const source = Array.from(pre.querySelectorAll('.ec-line')).map((l) => l.textContent).join('\\n');
            if (!source.trim()) continue;
            const id = 'mermaid-' + Math.random().toString(36).slice(2, 9);
            try {
              const { svg } = await mermaid.render(id, source);
              const wrap = document.createElement('div');
              wrap.className = 'mermaid';
              wrap.innerHTML = svg;
              pre.replaceWith(wrap);
            } catch (err) {
              console.error('Mermaid render failed:', err);
              pre.textContent = source;
            }
          }
        `,
        );
      },
    },
  };
}
