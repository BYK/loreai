// Search the reference itself rather than its repeated navigation inventory.
// Keep every node and anchor in the rendered document, including without JS.
export default function referenceSearch() {
  return (tree) => {
    const text = (node) =>
      node.value ?? node.children?.map(text).join("") ?? "";
    function visit(parent) {
      let reference = false;
      for (const node of parent.children ?? []) {
        if (node.type === "element") {
          if (node.tagName === "h2")
            reference = ["Field reference", "Setting reference"].includes(
              text(node),
            );
          else if (reference) {
            if (node.tagName === "ul")
              node.properties = { ...node.properties, dataPagefindIgnore: "" };
            reference = false;
          }
          if (node.tagName === "thead")
            node.properties = { ...node.properties, dataPagefindIgnore: "" };
        }
        if (node.children) visit(node);
      }
    }
    visit(tree);
  };
}
