// Mermaid renderer integration.
//
// Replaces the previous CDN-loaded script in starlight's head config. The
// renderer is bundled with the site via `injectScript`, so it runs on every
// page (Starlight docs AND the blog) without a network dependency. The
// render target is any `pre[data-language="mermaid"]` block on the page,
// replaced with the rendered SVG.
//
// Syntax-highlighter compatibility:
// - Starlight docs use Expressive Code, which wraps each line in a
//   `<div class="ec-line">`. We extract source per-line from those divs.
// - Blog posts use Astro's default Shiki highlighter, which wraps each line
//   in a `<span class="line">` (or, for unknown languages, leaves the
//   source as plain text inside the `<pre>`). We accept both line-class
//   shapes via a combined selector, and fall back to the pre's textContent
//   when neither is present (e.g. unknown-language plain text).
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
            fontFamily: "var(--sl-font, system-ui, -apple-system, sans-serif)"
          });
          const blocks = document.querySelectorAll('pre[data-language="mermaid"]');
          for (const pre of blocks) {
            const lines = pre.querySelectorAll('.ec-line, .line');
            let source = '';
            if (lines.length > 0) {
              source = Array.from(lines).map((l) => l.textContent).join('\\n');
            } else {
              const code = pre.querySelector('code') || pre;
              source = code.textContent || '';
            }
            if (!source.trim()) continue;
            const id = 'mermaid-' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
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
