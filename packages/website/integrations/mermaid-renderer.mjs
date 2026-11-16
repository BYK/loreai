// No Mermaid runtime download on pages without authored diagrams.
export default function mermaidRenderer() {
  return {
    name: "mermaid-renderer",
    hooks: {
      "astro:config:setup": ({ injectScript }) => {
        injectScript(
          "page",
          `if (document.querySelector('a[data-media-viewer]')) await import('/src/scripts/media-viewer');
if (document.querySelector('pre[data-language="mermaid"]')) await import('/src/scripts/mermaid');`,
        );
      },
    },
  };
}
